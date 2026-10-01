import { slotOn } from './reports.js';

// Nightly cleanup of the database (docs/PIANO-AGENTE.md, phase 5). Raw 1 Hz
// rows are needed only for recent investigations: the summaries stay. Battery
// rows recorded during a test (charge, discharge and the rest around them) are
// the experiment itself and are kept. With dryRun nothing is deleted: the log
// says what would go.

const MINUTE_MS = 60000;
const DAY_MS = 24 * 3600000;
// The weekly report and /report settimana read 7 days of raw battery data
export const MIN_RAW_DAYS = 8;

const pad = (n) => String(n).padStart(2, '0');
function formatLocal(ms) {
	const d = new Date(ms);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function validateRetention(config) {
	if (!config?.enabled) return;
	slotOn(0, config.time);
	for (const key of ['labRawDays', 'batteryIdleDays']) {
		if (!(config[key] >= MIN_RAW_DAYS)) throw new Error(`retention.${key}: almeno ${MIN_RAW_DAYS} giorni`);
	}
	if (config.batteryTestDays && config.batteryTestDays < config.batteryIdleDays) {
		throw new Error('retention.batteryTestDays: 0 (mai) oppure non meno di batteryIdleDays');
	}
	if (config.summaryMinuteDays && config.summaryMinuteDays < MIN_RAW_DAYS) {
		throw new Error(`retention.summaryMinuteDays: 0 (mai) oppure almeno ${MIN_RAW_DAYS} giorni`);
	}
}

// Minutes with the battery running (local "YYYY-MM-DD HH:MM:00" strings), each
// widened by marginMs and merged -> sorted protected intervals [start, end)
export function protectedIntervals(activeMinutes, marginMs) {
	const spans = activeMinutes
		.map((minute) => new Date(String(minute).replace(' ', 'T')).getTime())
		.filter(Number.isFinite)
		.sort((a, b) => a - b)
		.map((t) => [t - marginMs, t + MINUTE_MS + marginMs]);
	const merged = [];
	for (const span of spans) {
		const last = merged.at(-1);
		if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
		else merged.push(span);
	}
	return merged;
}

// Parts of [fromMs, toMs) outside the protected intervals
export function freeRanges(fromMs, toMs, intervals) {
	const ranges = [];
	let cursor = fromMs;
	for (const [start, end] of intervals) {
		if (end <= cursor) continue;
		if (start >= toMs) break;
		if (start > cursor) ranges.push([cursor, Math.min(start, toMs)]);
		cursor = Math.max(cursor, end);
	}
	if (cursor < toMs) ranges.push([cursor, toMs]);
	return ranges;
}

export class Retention {
	constructor({ db, state, config, tables, log = console, now = () => Date.now(), pause = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
		for (const table of Object.values(tables)) {
			if (!/^\w+$/.test(table)) throw new Error(`Invalid table name: ${table}`);
		}
		validateRetention(config);
		this.db = db;
		this.state = state;
		this.config = config;
		this.tables = tables;
		this.log = log;
		this.now = now;
		this.pause = pause;
		this.running = false;
	}

	describe() {
		const c = this.config;
		if (!c?.enabled) return 'Pulizia del database disattivata.';
		const test = c.batteryTestDays ? `${c.batteryTestDays} giorni` : 'sempre';
		return `Pulizia del database alle ${c.time}${c.dryRun ? ' (prova a vuoto: nessuna cancellazione)' : ''}: laboratorio ${c.labRawDays} giorni, batteria ferma ${c.batteryIdleDays} giorni, prove batteria ${test}.`;
	}

	async tick() {
		if (!this.config?.enabled || this.running || !this.db.ready) return;
		const now = this.now();
		const slot = slotOn(now, this.config.time);
		const day = formatLocal(slot).slice(0, 10);
		if (now < slot || this.state.get('retention.lastDay') === day) return;
		await this.state.set('retention.lastDay', day);
		await this.run();
	}

	// Raw rows still to be summarized are never touched
	aggregatedUntil(fallback) {
		const cursors = ['minute', 'hour'].map((g) => this.state.get(`aggregation.${g}.cursor`));
		return cursors.every(Number.isFinite) ? Math.min(...cursors) : fallback;
	}

	async run() {
		this.running = true;
		const started = this.now();
		const verb = this.config.dryRun ? 'would delete' : 'deleted';
		const report = {};
		try {
			const now = this.now();
			const days = (n) => now - n * DAY_MS;
			const safe = (cutoff) => Math.min(cutoff, this.aggregatedUntil(-Infinity));

			report.lab = await this.purge(this.tables.lab, 'recorded_at', safe(days(this.config.labRawDays)));
			report.batteryIdle = await this.purgeBatteryIdle(safe(days(this.config.batteryIdleDays)));
			if (this.config.batteryTestDays) {
				report.batteryTest = await this.purge(this.tables.battery, 'recorded_at', safe(days(this.config.batteryTestDays)));
			}
			if (this.config.summaryMinuteDays) {
				report.summaryMinute = await this.purge('summary_minute', 'bucket_start', days(this.config.summaryMinuteDays));
			}

			const parts = Object.entries(report).map(([name, count]) => `${name} ${count}`).join(', ');
			this.log.log(`[RETENTION] ${verb}: ${parts} rows (${Math.round((this.now() - started) / 1000)} s)`);
			await this.state.set('retention.last', { at: started, dryRun: Boolean(this.config.dryRun), rows: report });
		} catch (error) {
			this.log.error('[ERROR] Retention failed:', error.message);
		} finally {
			this.running = false;
		}
		return report;
	}

	// Rows older than cutoff, in small batches so the services keep writing
	async purge(table, column, cutoff, extra = '', params = []) {
		if (!Number.isFinite(cutoff)) return 0;
		const where = `${column} < ?${extra}`;
		const args = [new Date(cutoff), ...params];
		if (this.config.dryRun) {
			const [row] = await this.db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, args);
			return Number(row?.n ?? 0);
		}
		let total = 0;
		for (;;) {
			const result = await this.db.query(`DELETE FROM ${table} WHERE ${where} LIMIT ${Number(this.config.batchRows)}`, args);
			const affected = Number(result?.affectedRows ?? 0);
			total += affected;
			if (affected < this.config.batchRows) return total;
			await this.pause(this.config.batchPauseMs ?? 200);
		}
	}

	// Idle rows (run_state 0) older than cutoff, except those within
	// testMarginMinutes of a running battery (rest phases are part of a test).
	// Processed one day at a time from the oldest idle row.
	async purgeBatteryIdle(cutoff) {
		if (!Number.isFinite(cutoff)) return 0;
		const table = this.tables.battery;
		const [oldest] = await this.db.query(`SELECT MIN(recorded_at) AS t FROM ${table} WHERE run_state = 0 AND recorded_at < ?`, [new Date(cutoff)]);
		if (!oldest?.t) return 0;
		const marginMs = (this.config.testMarginMinutes ?? 60) * MINUTE_MS;

		let total = 0;
		for (let from = new Date(oldest.t).getTime(); from < cutoff; from += DAY_MS) {
			const to = Math.min(from + DAY_MS, cutoff);
			const active = await this.db.query(
				`SELECT DATE_FORMAT(recorded_at, '%Y-%m-%d %H:%i:00') AS minute FROM ${table}
				WHERE run_state <> 0 AND recorded_at >= ? AND recorded_at < ? GROUP BY minute`,
				[new Date(from - marginMs), new Date(to + marginMs)]
			);
			const keep = protectedIntervals(active.map((row) => row.minute), marginMs);
			for (const [start, end] of freeRanges(from, to, keep)) {
				total += await this.purge(table, 'recorded_at', end, ' AND recorded_at >= ? AND run_state = 0', [new Date(start)]);
			}
		}
		return total;
	}
}
