import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CycleDetector, describePhase, normalizeRow, PhaseTracker } from '../supervisor/cycles.js';
import { buildCyclesResult, observedSigns, pairCycles, phaseFromRow } from '../mcp/cycles.js';
import { createTools } from '../mcp/tools.js';
import { silentLog } from './helpers.js';

const T0 = new Date(2026, 9, 2, 10, 0).getTime();
const CONFIG = { enabled: true, minPhaseSeconds: 30, maxIntegrateGapSeconds: 5, splitGapSeconds: 600, ccTolerancePct: 5, cvToleranceMv: 20, restWindowSeconds: 10, lagSeconds: 15 };

// One raw row per second from `from` for `seconds`; fn(k) gives the values
function rows(from, seconds, fn) {
	return Array.from({ length: seconds }, (_, k) => ({
		recorded_at: new Date(from + k * 1000),
		battery_type: 1,
		current_setpoint_ma: 1000,
		voltage_setpoint_mv: 4200,
		...fn(k)
	}));
}

// 10 s rest at 3700 mV, 1 h charge (30 min CC at 1000 mA, 30 min CV at 4200 mV with 300 mA), 10 s rest
function chargeSession(start = T0, sign = 1) {
	return [
		...rows(start, 10, () => ({ run_state: 0, current_measured_ma: 0, voltage_measured_mv: 3700 })),
		...rows(start + 10000, 3600, (k) => k < 1800
			? { run_state: 1, current_measured_ma: sign * 1000, voltage_measured_mv: k === 0 ? 3700 : 3800 }
			: { run_state: 1, current_measured_ma: sign * 300, voltage_measured_mv: 4200 }),
		...rows(start + 3610000, 10, () => ({ run_state: 0, current_measured_ma: 0, voltage_measured_mv: 4150 }))
	];
}

function feed(tracker, list) {
	return list.flatMap((row) => tracker.push(normalizeRow(row)));
}

test('charge phase: capacity, energy, CC/CV, resistance, sign', () => {
	const tracker = new PhaseTracker(CONFIG);
	const [phase, ...rest] = feed(tracker, chargeSession());
	assert.equal(rest.length, 0);
	assert.equal(phase.runState, 1);
	assert.equal(phase.durationS, 3599);
	assert.equal(phase.endReason, 'state_change');
	assert.equal(phase.nextState, 0);
	assert.equal(phase.currentSign, 1);
	// 1799 s at 1000 mA + the step + 1799 s at 300 mA
	assert.ok(Math.abs(phase.chargeMah - (1799 * 1000 + 650 + 1799 * 300) / 3600) < 0.01, phase.chargeMah);
	// 30 min at 3.8 V and 1 A + 30 min at 4.2 V and 0.3 A
	assert.ok(Math.abs(phase.energyWh - 2.53) < 0.01, phase.energyWh);
	assert.equal(Math.round(phase.ccS), 1799);
	assert.equal(Math.round(phase.cvS), 1800);
	// First loaded sample is 3700 mV (no step), rest after: 4200 -> 4150 mV at 300 mA
	assert.equal(phase.rStartMohm, 0);
	assert.equal(phase.rEndMohm, 166.7);
	assert.equal(phase.vMinMv, 3700);
	assert.equal(phase.vMaxMv, 4200);
	assert.equal(phase.iSetMa, 1000);
	assert.match(describePhase(phase), /^Carica conclusa: 1 h 0 min, 650 mAh, 2,53 Wh, 3,70 → 4,20 V \(corrente misurata positiva\)$/);
});

test('discharge with negative current: magnitude stored, sign recorded', () => {
	const list = [
		...rows(T0, 5, () => ({ run_state: 0, current_measured_ma: 0, voltage_measured_mv: 4100 })),
		...rows(T0 + 5000, 600, () => ({ run_state: 2, current_setpoint_ma: 500, current_measured_ma: -500, voltage_measured_mv: 3900 })),
		...rows(T0 + 605000, 5, () => ({ run_state: 0, current_measured_ma: 0, voltage_measured_mv: 3950 }))
	];
	const [phase] = feed(new PhaseTracker(CONFIG), list);
	assert.equal(phase.currentSign, -1);
	assert.ok(Math.abs(phase.chargeMah - (599 * 500) / 3600) < 0.01);
	// 4100 -> 3900 mV at 500 mA = 400 mOhm; 3900 -> 3950 mV = 100 mOhm
	assert.equal(phase.rStartMohm, 400);
	assert.equal(phase.rEndMohm, 100);
	assert.match(describePhase(phase), /negativa/);
});

// The real register reads 1 in discharge too (lib/run-state.js)
test('register at 1 in discharge: direction from the current, switch without a stop splits', () => {
	const discharge = [
		...rows(T0, 5, () => ({ run_state: 0, current_measured_ma: 0, voltage_measured_mv: 4100 })),
		// First samples before the current is established
		...rows(T0 + 5000, 2, () => ({ run_state: 1, current_setpoint_ma: 500, current_measured_ma: 0, voltage_measured_mv: 4100 })),
		...rows(T0 + 7000, 600, () => ({ run_state: 1, current_setpoint_ma: 500, current_measured_ma: -500, voltage_measured_mv: 3900 })),
		...rows(T0 + 607000, 5, () => ({ run_state: 0, current_measured_ma: 0, voltage_measured_mv: 3950 }))
	];
	const tracker = new PhaseTracker(CONFIG);
	const [phase, ...rest] = feed(tracker, discharge);
	assert.equal(rest.length, 0);
	assert.equal(phase.runState, 2);
	assert.equal(phase.startedAt, T0 + 5000);
	assert.equal(phase.currentSign, -1);
	assert.equal(phase.rStartMohm, 400);
	assert.match(describePhase(phase), /^Scarica conclusa/);

	// Charge switched to discharge without a stop: two phases
	const switched = [
		...rows(T0, 300, () => ({ run_state: 1, current_measured_ma: 500, voltage_measured_mv: 3800 })),
		...rows(T0 + 300000, 300, () => ({ run_state: 1, current_measured_ma: -500, voltage_measured_mv: 3700 })),
		...rows(T0 + 600000, 5, () => ({ run_state: 0, current_measured_ma: 0, voltage_measured_mv: 3750 }))
	];
	const phases = feed(new PhaseTracker(CONFIG), switched);
	assert.deepEqual(phases.map((p) => [p.runState, p.nextState]), [[1, 2], [2, 0]]);

	// In progress: discharge as soon as the current shows it
	const open = new PhaseTracker(CONFIG);
	feed(open, discharge.slice(0, 50));
	assert.equal(open.inProgress().state, 'scarica');
});

test('gaps: short ones not integrated, long ones split the phase, short phases ignored', () => {
	const tracker = new PhaseTracker(CONFIG);
	const list = [
		...rows(T0, 100, () => ({ run_state: 1, current_measured_ma: 1000, voltage_measured_mv: 3800 })),
		// 60 s without data: kept in the phase, not integrated
		...rows(T0 + 160000, 100, () => ({ run_state: 1, current_measured_ma: 1000, voltage_measured_mv: 3800 })),
		// 20 min without data: the phase ends
		...rows(T0 + 1460000, 100, () => ({ run_state: 1, current_measured_ma: 1000, voltage_measured_mv: 3800 })),
		...rows(T0 + 1560000, 10, () => ({ run_state: 0, current_measured_ma: 0, voltage_measured_mv: 3700 })),
		// 20 s glitch: below minPhaseSeconds
		...rows(T0 + 1570000, 20, () => ({ run_state: 2, current_measured_ma: -1000, voltage_measured_mv: 3700 })),
		...rows(T0 + 1590000, 5, () => ({ run_state: 0, current_measured_ma: 0, voltage_measured_mv: 3700 }))
	];
	const phases = feed(tracker, list);
	assert.equal(phases.length, 2);
	assert.equal(phases[0].endReason, 'data_gap');
	assert.equal(phases[0].gapS, 61);
	assert.equal(phases[0].nextState, null);
	assert.equal(phases[0].rEndMohm, null);
	assert.ok(Math.abs(phases[0].chargeMah - 198000 / 3600) < 0.01);
	assert.equal(phases[1].endReason, 'state_change');
	assert.equal(phases[1].startedAt, T0 + 1460000);

	// No new rows at all: flush closes the phase once splitGapSeconds have passed
	const open = new PhaseTracker(CONFIG);
	feed(open, rows(T0, 100, () => ({ run_state: 2, current_measured_ma: -1000, voltage_measured_mv: 3700 })));
	assert.equal(open.flush(T0 + 300000).length, 0);
	assert.equal(open.inProgress().state, 'scarica');
	assert.equal(open.inProgress().chargeMah, 28);
	assert.equal(open.flush(T0 + 800000).length, 1);
	assert.equal(open.inProgress(), null);
});

test('state saved as JSON mid-phase gives the same result', () => {
	const list = chargeSession();
	const whole = feed(new PhaseTracker(CONFIG), list);
	const first = new PhaseTracker(CONFIG);
	feed(first, list.slice(0, 1000));
	const resumed = new PhaseTracker(CONFIG, JSON.parse(JSON.stringify(first.toJSON())));
	assert.deepEqual(feed(resumed, list.slice(1000)), whole);
});

// Fake database over an in-memory list of raw rows
function detectorSetup(raw, { now = T0 + 2 * 3600000, saved = null } = {}) {
	const calls = [];
	const inserted = [];
	const values = new Map(saved ? [['cycles', saved]] : []);
	const db = {
		ready: true,
		async query(sql, params = []) {
			calls.push({ sql, params });
			if (sql.startsWith('SELECT MIN(recorded_at)')) {
				const from = params[0]?.getTime() ?? -Infinity;
				const t = raw.map((r) => r.recorded_at.getTime()).filter((x) => x >= from);
				return [{ t: t.length ? new Date(Math.min(...t)) : null }];
			}
			if (sql.startsWith('SELECT recorded_at')) {
				const [a, b] = params.map((d) => d.getTime());
				return raw.filter((r) => r.recorded_at.getTime() >= a && r.recorded_at.getTime() < b);
			}
			if (sql.startsWith('INSERT INTO battery_phases')) {
				inserted.push(params);
				return { affectedRows: 1 };
			}
			throw new Error(`unexpected query ${sql}`);
		}
	};
	const notified = [];
	const detector = new CycleDetector({
		db,
		state: { get: (key) => values.get(key) ?? null, set: async (key, value) => values.set(key, value) },
		config: CONFIG,
		table: 'battery_measurements',
		onPhase: (phase) => notified.push(phase),
		log: silentLog,
		now: () => now
	});
	return { detector, calls, inserted, values, notified };
}

test('detector: starts from the oldest row, skips empty hours, saves phases and cursor', async () => {
	// A charge, then nothing for 5 days, then another charge
	const later = T0 + 5 * 86400000;
	const raw = [...chargeSession(T0), ...chargeSession(later)];
	const { detector, calls, inserted, values, notified } = detectorSetup(raw, { now: later + 3 * 3600000 });
	await detector.run();
	assert.equal(inserted.length, 2);
	assert.match(calls.find((c) => c.sql.startsWith('INSERT')).sql, /ON DUPLICATE KEY UPDATE ended_at = VALUES\(ended_at\)/);
	assert.equal(inserted[0][0].getTime(), T0 + 10000);
	assert.equal(notified.length, 2);
	assert.equal(values.get('cycles').cursor, later + 3 * 3600000 - 15000);
	assert.equal(values.get('cycles').open, null);
	// Hour chunks only where there is data: the 5 empty days cost one query
	assert.ok(calls.filter((c) => c.sql.startsWith('SELECT recorded_at')).length < 10);

	// Nothing new: nothing written again
	await detector.run();
	assert.equal(inserted.length, 2);
	assert.throws(() => new CycleDetector({ db: {}, state: {}, config: CONFIG, table: 'x y' }), /Invalid table/);
});

test('detector: phase in progress kept across runs and in the status', async () => {
	const raw = chargeSession(T0);
	const { detector, inserted, values } = detectorSetup(raw, { now: T0 + 1800000 });
	await detector.run();
	assert.equal(inserted.length, 0);
	assert.equal(detector.inProgress().state, 'carica');
	assert.ok(values.get('cycles').open);

	// A fresh process continues from the saved state
	const next = detectorSetup(raw, { now: T0 + 2 * 3600000, saved: values.get('cycles') });
	await next.detector.run();
	assert.equal(next.inserted.length, 1);
	assert.equal(next.inserted[0][0].getTime(), T0 + 10000);
	assert.equal(next.inserted[0][6], 3599);
});

// ─── MCP: get_battery_cycles ───────────────────────────────────────────────

function phaseDbRow(id, state, start, minutes, mah, wh, extra = {}) {
	return {
		id: BigInt(id), started_at: new Date(start), ended_at: new Date(start + minutes * 60000), run_state: state, battery_type: 1,
		end_reason: 'state_change', next_state: 0, duration_s: minutes * 60, samples: minutes * 60, gap_s: 0,
		charge_mah: mah, energy_wh: wh, current_sign: state === 1 ? 1 : -1, v_start_mv: 3700, v_end_mv: 4200, v_min_mv: 3700, v_max_mv: 4200,
		i_avg_ma: 800, i_max_ma: 1000, i_set_ma: 1000, v_set_mv: 4200, cc_s: 1800, cv_s: 1200, r_start_mohm: 80.4, r_end_mohm: 95, ...extra
	};
}

test('cycles: charge followed by discharge, efficiencies, observed signs', () => {
	const H = 3600000;
	const phases = [
		phaseDbRow(1, 1, T0, 120, 2500, 10),
		phaseDbRow(2, 2, T0 + 3 * H, 150, 2400, 8.8),
		phaseDbRow(3, 1, T0 + 6 * H, 120, 2450, 9.8, { battery_type: 2 }),
		phaseDbRow(4, 2, T0 + 9 * H, 150, 2300, 8.5),
		phaseDbRow(5, 1, T0 + 12 * H, 100, 2000, 8, { end_reason: 'data_gap', current_sign: -1 }),
		phaseDbRow(6, 2, T0 + 60 * H, 100, 1900, 7)
	].map(phaseFromRow);
	const cycles = pairCycles(phases, { maxRestHours: 24 });
	assert.equal(cycles.length, 1);
	assert.deepEqual(cycles[0], { charge: 1, discharge: 2, at: '2026-10-02 13:00', restMin: 60, chargeMah: 2500, dischargeMah: 2400, coulombicPct: 96, chargeWh: 10, dischargeWh: 8.8, energyPct: 88 });
	assert.deepEqual(observedSigns(phases), { carica: 'misto (2 positive, 1 negative)', scarica: 'negativa' });
	assert.equal(pairCycles(phases, { maxRestHours: 100 }).at(-1).incomplete, true);
});

test('get_battery_cycles: phases, cycles and the phase in progress', async () => {
	const NOW = T0 + 10 * 3600000;
	const calls = [];
	const saved = { cursor: NOW, open: { state: 2, startT: NOW - 1800000, lastT: NOW - 60000, q: -900000, e: -3.4e9 }, last: null };
	const db = {
		async query(sql, params, options) {
			calls.push({ sql, params, options });
			if (sql.includes('FROM battery_phases')) return [phaseDbRow(2, 2, T0 + 3 * 3600000, 150, 2400, 8.8), phaseDbRow(1, 1, T0, 120, 2500, 10)];
			return [{ state_value: JSON.stringify(saved) }];
		}
	};
	const tools = createTools({ db, bus: null, notes: null, now: () => NOW, config: { cycles: { maxPhases: 1 } } });
	const one = await tools.get_battery_cycles({});
	assert.equal(one.truncated, true);
	assert.equal(calls[0].params[0].getTime(), NOW - 30 * 86400000);
	assert.match(calls[0].sql, /LIMIT 2$/);

	const all = createTools({ db, bus: null, notes: null, now: () => NOW, config: {} });
	const data = await all.get_battery_cycles({ since: '-1d' });
	assert.equal(data.phases.length, 2);
	assert.equal(data.phases[0][0], 1);
	assert.equal(data.phases[0][data.columns.indexOf('ccMin')], 30);
	assert.equal(data.phases[1][data.columns.indexOf('endedBy')], 'ferma');
	assert.equal(data.cycles[0].coulombicPct, 96);
	assert.deepEqual(data.currentSign, { carica: 'positiva', scarica: 'negativa' });
	assert.deepEqual(data.inProgress, { state: 'scarica', since: '2026-10-02 19:30', minutes: 29, mAh: 250, Wh: 0.94, currentSign: -1, lastDataAgeMin: 1 });

	const missing = createTools({ db: { query: async () => { throw Object.assign(new Error('x'), { sqlMessage: "Table 'sensor_data.battery_phases' doesn't exist" }); } }, bus: null, notes: null, config: {} });
	await assert.rejects(missing.get_battery_cycles({}), /battery_phases' doesn't exist/);
});

test('buildCyclesResult without data', () => {
	const result = buildCyclesResult({ rows: [], truncated: false, saved: null, now: T0, sinceMs: T0 - 86400000, maxRestHours: 24 });
	assert.deepEqual(result.phases, []);
	assert.deepEqual(result.cycles, []);
	assert.deepEqual(result.currentSign, {});
	assert.equal(result.inProgress, null);
});
