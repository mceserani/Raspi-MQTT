import { formatLocal, roundValue } from './format.js';
import { runStateSql } from '../lib/run-state.js';

// Numbers for the daily and weekly reports, computed here so the agent only
// interprets them (docs/PIANO-AGENTE.md, 5.4 and 6): one tool call instead of
// many get_summary/query_readonly rounds.

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const RUN_STATES = { 0: 'ferma', 1: 'carica', 2: 'scarica' };

export function floorToHour(ms) {
	const date = new Date(ms);
	date.setMinutes(0, 0, 0);
	return date.getTime();
}

const pad = (n) => String(n).padStart(2, '0');

function weightedAvg(rows) {
	let sum = 0;
	let samples = 0;
	for (const row of rows) {
		if (row.avg === null || !row.samples) continue;
		sum += row.avg * row.samples;
		samples += row.samples;
	}
	return samples > 0 ? sum / samples : null;
}

// Hourly rows of one metric -> period statistics. expectedSamples assumes the
// 1 Hz polling of the existing services.
export function summarizeMetric(rows, { fromMs, toMs, previousAvg = null, reference = null }) {
	const withData = rows.filter((row) => row.samples > 0);
	const samples = withData.reduce((total, row) => total + row.samples, 0);
	const expectedSamples = (toMs - fromMs) / 1000;
	const avg = weightedAvg(withData);
	const pick = (key, fn) => {
		const values = withData.map((row) => row[key]).filter((v) => v !== null);
		return values.length ? fn(...values) : null;
	};

	const result = {
		avg: roundValue(avg),
		min: roundValue(pick('min', Math.min)),
		max: roundValue(pick('max', Math.max)),
		p95: roundValue(pick('p95', Math.max)),
		coveragePct: roundValue(Math.min(100, (samples / expectedSamples) * 100), 1),
		hoursWithoutData: Math.round((toMs - fromMs) / HOUR_MS) - withData.length,
		maxGapS: roundValue(pick('maxGapS', Math.max), 0)
	};

	if (previousAvg !== null && avg !== null) {
		result.previousAvg = roundValue(previousAvg);
		if (Math.abs(previousAvg) > 1e-9) result.changePct = roundValue(((avg - previousAvg) / Math.abs(previousAvg)) * 100, 0);
	}

	// Typical day: mean by hour of day, to spot recurring peaks
	if (withData.length >= 6) {
		const byHour = new Map();
		for (const row of withData) {
			const hour = new Date(row.bucket).getHours();
			if (!byHour.has(hour)) byHour.set(hour, []);
			byHour.get(hour).push(row);
		}
		const means = [...byHour].map(([hour, hourRows]) => ({ hour, avg: weightedAvg(hourRows) })).filter((h) => h.avg !== null);
		means.sort((a, b) => b.avg - a.avg);
		result.peakHour = { at: `${pad(means[0].hour)}:00`, avg: roundValue(means[0].avg) };
		result.lowHour = { at: `${pad(means.at(-1).hour)}:00`, avg: roundValue(means.at(-1).avg) };
	}

	// Reference values are 24 h means: compared on consecutive 24 h windows
	if (reference) {
		const windows = Math.max(1, Math.floor((toMs - fromMs) / DAY_MS));
		const windowAvgs = [];
		for (let i = 0; i < windows; i++) {
			const start = fromMs + i * DAY_MS;
			const end = i === windows - 1 ? toMs : start + DAY_MS;
			const windowAvg = weightedAvg(withData.filter((row) => row.bucket >= start && row.bucket < end));
			if (windowAvg !== null) windowAvgs.push(windowAvg);
		}
		result.reference = {
			value: reference.value,
			basis: reference.basis,
			windows24h: windowAvgs.length,
			windowsAbove: windowAvgs.filter((v) => v > reference.value).length,
			max24hAvg: windowAvgs.length ? roundValue(Math.max(...windowAvgs)) : null
		};
	}
	return result;
}

// Raw battery rows grouped by effective run state (run_mode, lib/run-state.js:
// the register reads 1 in discharge too) and battery_type -> time in each state.
// Charge in mAh = sum of the current samples / 3600 (1 sample per second).
export function summarizeBattery(rows) {
	const states = {};
	const types = {};
	for (const row of rows) {
		const samples = Number(row.samples);
		const mode = Number(row.run_mode ?? row.run_state);
		const label = RUN_STATES[mode] ?? `stato ${mode}`;
		const state = (states[label] ??= { minutes: 0, vMin: null, vMax: null, sumCurrent: 0, first: null, last: null });
		state.minutes += samples / 60;
		state.vMin = state.vMin === null ? Number(row.v_min) : Math.min(state.vMin, Number(row.v_min));
		state.vMax = state.vMax === null ? Number(row.v_max) : Math.max(state.vMax, Number(row.v_max));
		state.sumCurrent += Number(row.sum_current ?? 0);
		const first = new Date(row.first_at).getTime();
		const last = new Date(row.last_at).getTime();
		state.first = state.first === null ? first : Math.min(state.first, first);
		state.last = state.last === null ? last : Math.max(state.last, last);
		const type = String(row.battery_type);
		types[type] = (types[type] ?? 0) + samples / 60;
	}

	const out = {};
	for (const [label, state] of Object.entries(states)) {
		out[label] = {
			minutes: roundValue(state.minutes, 0),
			voltageMv: [state.vMin, state.vMax],
			...(label === 'ferma' ? {} : { chargeMahEstimate: roundValue(Math.abs(state.sumCurrent) / 3600, 0) }),
			first: formatLocal(state.first, { seconds: false }),
			last: formatLocal(state.last, { seconds: false })
		};
	}
	const batteryTypeMinutes = Object.fromEntries(Object.entries(types).map(([type, minutes]) => [type, roundValue(minutes, 0)]));
	return { states: out, batteryTypeMinutes };
}

// Events grouped by condition (event_key): how often, how long, how severe.
export function summarizeEvents(rows, agentRows, { maxGroups }) {
	const bySeverity = { critical: 0, warning: 0, info: 0 };
	const groups = rows.map((row) => {
		bySeverity[row.peak_severity] += Number(row.n);
		return {
			key: row.event_key,
			severity: row.peak_severity,
			count: Number(row.n),
			open: Number(row.still_open),
			totalMin: roundValue(Number(row.duration_s) / 60, 0),
			example: row.example
		};
	});
	const rank = { critical: 0, warning: 1, info: 2 };
	groups.sort((a, b) => rank[a.severity] - rank[b.severity] || b.count - a.count);
	const agent = Object.fromEntries(agentRows.map((row) => [row.agent_status, Number(row.n)]));
	return {
		bySeverity,
		groups: groups.slice(0, maxGroups),
		...(groups.length > maxGroups ? { omittedGroups: groups.length - maxGroups } : {}),
		triage: agent
	};
}

export async function buildReportData({ db, fromMs, toMs, references = {}, batteryTable, maxGroups = 15 }) {
	const from = new Date(fromMs);
	const to = new Date(toMs);
	const previousFrom = new Date(fromMs - (toMs - fromMs));
	const hourRows = Math.ceil((toMs - fromMs) / HOUR_MS) * 9 + 1;

	// Sequential: the read-only pool has two connections and the Pi is small
	const hourly = await db.query(
		`SELECT bucket_start, source, metric, samples, avg_value, min_value, max_value, p95_value, max_gap_s
		FROM summary_hour WHERE bucket_start >= ? AND bucket_start < ? ORDER BY bucket_start`,
		[from, to],
		{ rowLimit: hourRows }
	);
	const previous = await db.query(
		`SELECT source, metric, SUM(avg_value * samples) / NULLIF(SUM(samples), 0) AS avg_value
		FROM summary_hour WHERE bucket_start >= ? AND bucket_start < ? AND samples > 0 GROUP BY source, metric`,
		[previousFrom, from]
	);
	const events = await db.query(
		`SELECT event_key, peak_severity, COUNT(*) AS n, SUM(resolved_at IS NULL) AS still_open,
			SUM(TIMESTAMPDIFF(SECOND, created_at, LEAST(COALESCE(resolved_at, ?), ?))) AS duration_s, MAX(message) AS example
		FROM supervisor_events WHERE created_at >= ? AND created_at < ? GROUP BY event_key, peak_severity`,
		[to, to, from, to],
		{ rowLimit: 500 }
	);
	const agent = await db.query(
		`SELECT agent_status, COUNT(*) AS n FROM supervisor_events
		WHERE created_at >= ? AND created_at < ? AND peak_severity IN ('warning', 'critical') GROUP BY agent_status`,
		[from, to]
	);

	const series = new Map();
	for (const row of hourly) {
		const key = `${row.source}.${row.metric}`;
		if (!series.has(key)) series.set(key, []);
		series.get(key).push({
			bucket: new Date(row.bucket_start).getTime(),
			samples: Number(row.samples),
			avg: row.avg_value === null ? null : Number(row.avg_value),
			min: row.min_value === null ? null : Number(row.min_value),
			max: row.max_value === null ? null : Number(row.max_value),
			p95: row.p95_value === null ? null : Number(row.p95_value),
			maxGapS: Number(row.max_gap_s)
		});
	}
	const previousAvgs = new Map(previous.map((row) => [`${row.source}.${row.metric}`, row.avg_value === null ? null : Number(row.avg_value)]));

	const lab = {};
	const battery = {};
	for (const [key, rows] of series) {
		const [source, metric] = key.split('.');
		const stats = summarizeMetric(rows, {
			fromMs,
			toMs,
			previousAvg: previousAvgs.get(key) ?? null,
			reference: source === 'lab' ? references[metric] ?? null : null
		});
		(source === 'lab' ? lab : battery)[metric] = stats;
	}

	// The raw battery table is the only source of the run state: a long range can
	// be slow on the Pi, so a failure leaves the rest of the report intact
	let batteryActivity;
	try {
		const rows = await db.query(
			`SELECT ${runStateSql()} AS run_mode, battery_type, COUNT(*) AS samples, MIN(voltage_measured_mv) AS v_min, MAX(voltage_measured_mv) AS v_max,
				SUM(current_measured_ma) AS sum_current, MIN(recorded_at) AS first_at, MAX(recorded_at) AS last_at
			FROM ${batteryTable} WHERE recorded_at >= ? AND recorded_at < ? GROUP BY run_mode, battery_type`,
			[from, to],
			{ rowLimit: 100 }
		);
		batteryActivity = summarizeBattery(rows);
	} catch (error) {
		batteryActivity = { error: `attività batteria non disponibile: ${error.sqlMessage ?? error.message}` };
	}

	return {
		period: {
			from: formatLocal(fromMs, { seconds: false }),
			to: formatLocal(toMs, { seconds: false }),
			hours: Math.round((toMs - fromMs) / HOUR_MS),
			comparedWith: `${formatLocal(previousFrom, { seconds: false })} → ${formatLocal(fromMs, { seconds: false })}`
		},
		legend: 'avg/min/max/p95 sul periodo; coveragePct = campioni ricevuti rispetto a 1/s; previousAvg e changePct = periodo precedente di pari durata; peakHour/lowHour = ora del giorno con media più alta/bassa; reference = media su finestre di 24 h confrontata con il valore guida; chargeMahEstimate = somma della corrente misurata (1 campione/s).',
		lab,
		battery: { ...battery, activity: batteryActivity },
		events: summarizeEvents(events, agent, { maxGroups }),
		...(hourly.length === 0 ? { note: 'nessun riassunto orario nel periodo: le aggregazioni partono dall\'avvio del supervisore' } : {})
	};
}
