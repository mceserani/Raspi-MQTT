import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { freeRanges, protectedIntervals, Retention, validateRetention } from '../supervisor/retention.js';
import { silentLog } from './helpers.js';

const MIN = 60000;
const DAY = 24 * 60 * MIN;
const NOW = new Date(2026, 9, 20, 3, 0).getTime();
const CONFIG = { enabled: true, dryRun: false, time: '03:00', labRawDays: 14, batteryIdleDays: 14, testMarginMinutes: 60, batteryTestDays: 0, summaryMinuteDays: 365, batchRows: 2, batchPauseMs: 0 };
const TABLES = { lab: 'labsens_measurements', battery: 'battery_measurements' };

// Fake database: DELETE ... LIMIT removes up to batchRows from a counter per query shape
function setup({ config = CONFIG, rows = {}, active = [], oldestIdle = null, cursors = true, summariesFrom = new Date(NOW - 100 * DAY) } = {}) {
	const calls = [];
	const remaining = { ...rows };
	const values = new Map(cursors ? [['aggregation.minute.cursor', NOW - 60 * MIN], ['aggregation.hour.cursor', NOW - 60 * MIN]] : []);
	const db = {
		ready: true,
		async query(sql, params) {
			calls.push({ sql, params });
			if (sql.startsWith('SELECT MIN(bucket_start)')) return [{ t: summariesFrom }];
			if (sql.startsWith('SELECT MIN(recorded_at)')) return [{ t: oldestIdle }];
			if (sql.includes('DATE_FORMAT')) return active.map((minute) => ({ minute }));
			const table = /FROM (\w+)/.exec(sql)[1];
			if (sql.startsWith('SELECT COUNT')) return [{ n: BigInt(remaining[table] ?? 0) }];
			const n = Math.min(config.batchRows, remaining[table] ?? 0);
			remaining[table] = (remaining[table] ?? 0) - n;
			return { affectedRows: n };
		}
	};
	let now = NOW;
	const retention = new Retention({
		db,
		state: { get: (key, fallback = null) => (values.has(key) ? values.get(key) : fallback), set: async (key, value) => values.set(key, value) },
		config,
		tables: TABLES,
		log: silentLog,
		now: () => now,
		pause: async () => {}
	});
	return { retention, calls, values, remaining, at: (ms) => { now = ms; } };
}

test('configuration: at least 8 days of raw data, test rows kept longer than idle ones', () => {
	assert.doesNotThrow(() => validateRetention(CONFIG));
	assert.doesNotThrow(() => validateRetention({ enabled: false }));
	assert.throws(() => validateRetention({ ...CONFIG, labRawDays: 3 }), /almeno 8/);
	assert.throws(() => validateRetention({ ...CONFIG, batteryTestDays: 10 }), /batteryTestDays/);
	assert.throws(() => validateRetention({ ...CONFIG, time: '3' }), /non valido/);
	assert.throws(() => setup({ config: { ...CONFIG, summaryMinuteDays: 2 } }), /summaryMinuteDays/);
});

test('protected intervals: active minutes widened by the margin and merged', () => {
	const intervals = protectedIntervals(['2026-10-01 10:00:00', '2026-10-01 10:01:00', '2026-10-01 12:00:00'], 30 * MIN);
	const t = (h, m) => new Date(2026, 9, 1, h, m).getTime();
	assert.deepEqual(intervals, [[t(9, 30), t(10, 32)], [t(11, 30), t(12, 31)]]);
	assert.deepEqual(freeRanges(t(9, 0), t(13, 0), intervals), [[t(9, 0), t(9, 30)], [t(10, 32), t(11, 30)], [t(12, 31), t(13, 0)]]);
	assert.deepEqual(freeRanges(t(9, 0), t(10, 0), []), [[t(9, 0), t(10, 0)]]);
	assert.deepEqual(freeRanges(t(9, 40), t(10, 0), intervals), []);
});

test('runs once a day after its time, deletes in batches', async () => {
	const { retention, calls, values, remaining, at } = setup({ rows: { labsens_measurements: 5, summary_minute: 1 } });
	at(NOW - MIN);
	await retention.tick();
	assert.equal(calls.length, 0);

	at(NOW + 5 * MIN);
	await retention.tick();
	await retention.tick();
	assert.equal(remaining.labsens_measurements, 0);
	const labDeletes = calls.filter((c) => c.sql.startsWith('DELETE FROM labsens_measurements'));
	assert.equal(labDeletes.length, 3);
	assert.match(labDeletes[0].sql, /WHERE recorded_at < \? AND recorded_at >= \? LIMIT 2$/);
	assert.equal(labDeletes[0].params[0].getTime(), NOW + 5 * MIN - 14 * DAY);
	assert.equal(labDeletes[0].params[1].getTime(), NOW - 100 * DAY);
	assert.ok(calls.some((c) => c.sql.startsWith('DELETE FROM summary_minute WHERE bucket_start < ?')));
	// batteryTestDays 0: test rows are never deleted as such
	assert.ok(!calls.some((c) => c.sql.startsWith('DELETE FROM battery_measurements WHERE recorded_at < ? LIMIT')));
	assert.deepEqual(values.get('retention.last').rows, { lab: 5, batteryIdle: 0, summaryMinute: 1 });
	assert.equal(values.get('retention.lastDay'), '2026-10-20');
});

test('dry run only counts', async () => {
	const { retention, calls, values } = setup({ config: { ...CONFIG, dryRun: true }, rows: { labsens_measurements: 7 } });
	await retention.run();
	assert.ok(!calls.some((c) => c.sql.startsWith('DELETE')));
	assert.equal(values.get('retention.last').rows.lab, 7);
	assert.equal(values.get('retention.last').dryRun, true);
	assert.match(retention.describe(), /prova a vuoto/);
});

test('idle battery rows: the rest around a test is kept', async () => {
	const cutoff = NOW - 14 * DAY;
	const oldest = new Date(cutoff - DAY + 6 * 3600000);
	const testMinute = new Date(cutoff - DAY + 12 * 3600000);
	const label = `${testMinute.getFullYear()}-${String(testMinute.getMonth() + 1).padStart(2, '0')}-${String(testMinute.getDate()).padStart(2, '0')} 12:00:00`;
	const { retention, calls } = setup({ oldestIdle: oldest, active: [label], rows: { battery_measurements: 0 } });
	await retention.run();
	const idle = calls.filter((c) => c.sql.startsWith('DELETE FROM battery_measurements'));
	assert.equal(idle.length, 2);
	assert.match(idle[0].sql, /recorded_at < \? AND recorded_at >= \? AND run_state = 0 LIMIT 2/);
	// before 11:00 and from 13:01 (60 min margin around the 12:00 minute)
	assert.equal(idle[0].params[0].getHours(), 11);
	assert.equal(idle[1].params[1].getHours(), 13);
	assert.equal(idle[1].params[1].getMinutes(), 1);
	assert.equal(idle[1].params[0].getTime(), cutoff);
});

test('nothing is deleted before the aggregation has run', async () => {
	const { retention, calls } = setup({ cursors: false, rows: { labsens_measurements: 10 }, oldestIdle: new Date(NOW - 20 * DAY) });
	const report = await retention.run();
	assert.equal(report.lab, 0);
	assert.ok(!calls.some((c) => c.sql.includes('labsens_measurements') || c.sql.includes('battery_measurements')));
});

test('rows older than the first summary (before the supervisor) are kept', async () => {
	const from = new Date(NOW - 20 * DAY);
	const { retention, calls } = setup({ summariesFrom: from, rows: { labsens_measurements: 4 }, oldestIdle: from });
	await retention.run();
	const raw = calls.filter((c) => /(DELETE|MIN\(recorded_at\)).*(labsens|battery)_measurements/s.test(c.sql));
	assert.ok(raw.length > 0);
	for (const call of raw) {
		assert.match(call.sql, /recorded_at >= \?/);
		assert.ok(call.params.some((p) => p.getTime() >= from.getTime()));
	}

	// no hourly summaries yet: raw data is left alone
	const empty = setup({ summariesFrom: null, rows: { labsens_measurements: 4 }, oldestIdle: from });
	const report = await empty.retention.run();
	assert.equal(report.lab, 0);
	assert.ok(!empty.calls.some((c) => c.sql.includes('_measurements')));
});

test('rows not yet read by the battery phase detection are kept', async () => {
	const { retention, calls, values } = setup({ rows: { labsens_measurements: 4 } });
	values.set('cycles', { cursor: NOW - 20 * DAY, open: null, last: null });
	await retention.run();
	const lab = calls.find((c) => c.sql.startsWith('DELETE FROM labsens_measurements'));
	assert.equal(lab.params[0].getTime(), NOW - 20 * DAY);
});

test('shipped configuration starts as a dry run', async () => {
	const supervisor = JSON.parse(await readFile(new URL('../config/supervisor.json', import.meta.url), 'utf8'));
	assert.equal(supervisor.retention.dryRun, true);
	assert.doesNotThrow(() => validateRetention(supervisor.retention));
});
