import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTriagePrompt, Triage } from '../supervisor/triage.js';
import { silentLog } from './helpers.js';

const NOW = new Date(2026, 8, 30, 12, 0).getTime();
const CONFIG = { enabled: true, settleSeconds: 120, lookbackHours: 6, maxEventsPerJob: 10, minGapMinutes: 60, criticalMinGapMinutes: 10, maxEscalationsPerDay: 1 };

function event(id, severity, extra = {}) {
	return { id: BigInt(id), created_at: new Date(NOW - 600000), resolved_at: null, source: 'lab', type: 'threshold', peak_severity: severity, message: `evento ${id}`, ...extra };
}

function setup({ pending = [], lastJobAt = 0, online = true } = {}) {
	const queries = [];
	const jobs = [];
	const values = new Map([['triage.lastJobAt', lastJobAt]]);
	let now = NOW;
	const triage = new Triage({
		db: {
			ready: true,
			async query(sql, params) {
				queries.push({ sql, params });
				return sql.trim().startsWith('SELECT') ? pending : { affectedRows: 0 };
			}
		},
		state: { get: (key, fallback) => (values.has(key) ? values.get(key) : fallback), set: async (key, value) => values.set(key, value) },
		config: CONFIG,
		publishJob: async (job) => jobs.push(job),
		launcherOnline: () => online,
		log: silentLog,
		now: () => now
	});
	return { triage, queries, jobs, values, advance: (ms) => { now += ms; } };
}

const updates = (queries) => queries.filter((q) => q.sql.startsWith('UPDATE supervisor_events SET agent_status = ?')).map((q) => q.params);

test('triage prompt lists the events compactly', () => {
	const prompt = buildTriagePrompt([event(7, 'critical', { resolved_at: new Date(NOW - 60000) })]);
	assert.match(prompt, /^TRIAGE\./);
	assert.match(prompt, /#7 \[critical\] lab\/threshold dalle 2026-09-30 11:50, rientrato 2026-09-30 11:59: evento 7/);
});

test('pending events become one queued triage job', async () => {
	const { triage, queries, jobs } = setup({ pending: [event(1, 'warning'), event(2, 'critical')] });
	await triage.tick();
	assert.equal(jobs.length, 1);
	assert.equal(jobs[0].kind, 'triage');
	assert.deepEqual(jobs[0].eventIds, [1, 2]);
	assert.equal(jobs[0].replyTelegram, false);
	assert.deepEqual(updates(queries)[0], ['queued', 1, 2]);
	// Restart recovery ran first
	assert.match(queries[0].sql, /SET agent_status = 'pending' WHERE agent_status = 'queued'/);
});

test('jobs are spaced out: 60 min for warnings, 10 min with a critical', async () => {
	const warn = setup({ pending: [event(1, 'warning')], lastJobAt: NOW - 30 * 60000 });
	await warn.triage.tick();
	assert.equal(warn.jobs.length, 0);

	const crit = setup({ pending: [event(1, 'critical')], lastJobAt: NOW - 30 * 60000 });
	await crit.triage.tick();
	assert.equal(crit.jobs.length, 1);
});

test('nothing happens without the launcher or without events', async () => {
	const offline = setup({ pending: [event(1, 'critical')], online: false });
	await offline.triage.tick();
	assert.equal(offline.queries.length, 0);
	const empty = setup();
	await empty.triage.tick();
	assert.equal(empty.jobs.length, 0);
});

test('results update the events: ok -> handled, refused -> pending, error -> error', async () => {
	const { triage, queries, jobs } = setup({ pending: [event(1, 'critical')] });
	await triage.tick();
	await triage.onResult({ jobId: jobs[0].jobId, kind: 'triage', status: 'refused' });
	assert.deepEqual(updates(queries).at(-1), ['pending', 1, 'queued']);

	await triage.onResult({ jobId: 'triage-old', kind: 'triage', status: 'ok', eventIds: [5] });
	assert.deepEqual(updates(queries).at(-1), ['handled', 5, 'queued']);
	await triage.onResult({ jobId: 'triage-x', kind: 'triage', status: 'error', eventIds: [6] });
	assert.deepEqual(updates(queries).at(-1), ['error', 6, 'queued']);

	const before = queries.length;
	await triage.onResult({ jobId: 'ask-1', kind: 'ask', status: 'ok' });
	assert.equal(queries.length, before);
});

test('escalation starts one investigation, within the daily limit', async () => {
	const { triage, jobs, queries } = setup();
	await triage.onEscalate({ eventIds: [3, 4], summary: 'PM2.5 in crescita da tre ore' });
	assert.equal(jobs[0].kind, 'investigate');
	assert.equal(jobs[0].replyTelegram, true);
	assert.match(jobs[0].prompt, /^INDAGINE.*#3, #4.*PM2.5 in crescita/s);
	assert.deepEqual(updates(queries)[0], ['escalated', 3, 4]);

	await triage.onEscalate({ eventIds: [5], summary: 'altro' });
	assert.equal(jobs.length, 1);
});
