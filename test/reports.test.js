import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildReportData, summarizeBattery, summarizeEvents, summarizeMetric } from '../mcp/report.js';
import { createTools } from '../mcp/tools.js';
import { createCommandHandler } from '../supervisor/commands.js';
import { buildReportPrompt, daysBefore, parseWeekday, ReportScheduler, slotOn } from '../supervisor/reports.js';
import { silentLog } from './helpers.js';

const HOUR = 3600000;
// Friday 2 October 2026
const FRIDAY = new Date(2026, 9, 2, 0, 0).getTime();
const CONFIG = { enabled: true, delayMinutes: 2, maxDelayHours: 3, daily: { enabled: true, time: '18:00' }, weekly: { enabled: true, day: 'venerdì', time: '15:00' } };

function setup({ config = CONFIG, online = true, start = FRIDAY } = {}) {
	const jobs = [];
	const values = new Map();
	let now = start;
	let launcher = online;
	const scheduler = new ReportScheduler({
		state: { get: (key, fallback) => (values.has(key) ? values.get(key) : fallback), set: async (key, value) => values.set(key, value) },
		config,
		publishJob: async (job) => jobs.push(job),
		launcherOnline: () => launcher,
		log: silentLog,
		now: () => now
	});
	return { scheduler, jobs, values, at: (h, m = 0) => { now = FRIDAY + h * HOUR + m * 60000; }, setOnline: (v) => { launcher = v; } };
}

test('weekday names and times are parsed, typos are rejected', () => {
	assert.equal(parseWeekday('venerdì'), 5);
	assert.equal(parseWeekday('Venerdi'), 5);
	assert.equal(parseWeekday(0), 0);
	assert.throws(() => parseWeekday('friday'), /non valido/);
	assert.equal(new Date(slotOn(FRIDAY + 5 * HOUR, '18:00')).getHours(), 18);
	assert.throws(() => slotOn(FRIDAY, '25:00'), /non valido/);
	assert.throws(() => setup({ config: { ...CONFIG, daily: { enabled: true, time: '18' } } }), /non valido/);
	// One calendar week earlier, same local time
	assert.equal(new Date(daysBefore(FRIDAY + 15 * HOUR, 7)).getDate(), 25);
});

test('daily report: once, after the delay, on the last 24 h', async () => {
	const { scheduler, jobs, at } = setup();
	at(18, 1);
	await scheduler.tick();
	assert.equal(jobs.filter((j) => j.kind === 'report_daily').length, 0);

	at(18, 2);
	await scheduler.tick();
	at(18, 30);
	await scheduler.tick();
	const daily = jobs.filter((j) => j.kind === 'report_daily');
	assert.equal(daily.length, 1);
	assert.equal(daily[0].replyTelegram, true);
	assert.match(daily[0].prompt, /^REPORT GIORNALIERO\. Periodo: da 2026-10-01 18:00 a 2026-10-02 18:00\./);
});

test('weekly report only on its day, on the last 7 days', async () => {
	const { scheduler, jobs, at } = setup();
	at(15, 5);
	await scheduler.tick();
	assert.equal(jobs.length, 1);
	assert.equal(jobs[0].kind, 'report_weekly');
	assert.match(jobs[0].prompt, /^REPORT SETTIMANALE\. Periodo: da 2026-09-25 15:00 a 2026-10-02 15:00\./);

	// Saturday: no weekly report
	const saturday = setup({ start: FRIDAY + 24 * HOUR });
	saturday.at(24 + 15, 5);
	await saturday.scheduler.tick();
	assert.equal(saturday.jobs.filter((j) => j.kind === 'report_weekly').length, 0);
});

test('launcher offline: report waits, then is skipped after maxDelayHours', async () => {
	const { scheduler, jobs, values, at, setOnline } = setup({ config: { ...CONFIG, weekly: { enabled: false } } });
	setOnline(false);
	at(18, 5);
	await scheduler.tick();
	assert.equal(jobs.length, 0);

	setOnline(true);
	at(19);
	await scheduler.tick();
	assert.equal(jobs.length, 1);

	const late = setup({ config: { ...CONFIG, weekly: { enabled: false } }, online: false });
	late.at(21, 30);
	await late.scheduler.tick();
	late.setOnline(true);
	await late.scheduler.tick();
	assert.equal(late.jobs.length, 0);
	assert.equal(late.values.get('reports.daily.lastSlot'), '2026-10-02');
	assert.equal(values.get('reports.daily.lastSlot'), '2026-10-02');
});

test('disabled reports and /report on demand', async () => {
	const off = setup({ config: { ...CONFIG, enabled: false } });
	off.at(18, 5);
	await off.scheduler.tick();
	assert.equal(off.jobs.length, 0);

	const { scheduler, jobs, at } = setup();
	at(10);
	assert.deepEqual(await scheduler.onDemand('settimana'), { ok: true });
	assert.equal(jobs[0].kind, 'report');
	assert.equal(jobs[0].requestedBy, 'telegram');
	assert.match(jobs[0].prompt, /^REPORT SU RICHIESTA dell'utente\. Periodo: da 2026-09-25 10:00 a 2026-10-02 10:00\./);
	assert.equal((await scheduler.onDemand('mese')).ok, false);
	assert.equal(scheduler.describe(), 'Report programmati: giornaliero alle 18:00, settimanale il venerdì alle 15:00.');
	assert.match(buildReportPrompt({ kind: 'daily', fromMs: FRIDAY, toMs: FRIDAY + HOUR }), /CLAUDE\.md/);
});

test('/report command forwards the period', async () => {
	const requested = [];
	const handler = createCommandHandler({
		requestReport: async (period) => {
			requested.push(period);
			return period === 'giorno' || period === 'settimana' ? { ok: true, agent: { online: true, budget: { used: 1, max: 10, sonnetUsed: 1, sonnetMax: 5 } } } : { ok: false, message: 'Uso: /report [giorno|settimana]' };
		}
	});
	assert.match(await handler('report', []), /Report chiesto/);
	assert.match(await handler('report', ['Settimana']), /Report chiesto/);
	assert.match(await handler('report', ['mese']), /Uso: \/report/);
	assert.deepEqual(requested, ['giorno', 'settimana', 'mese']);
});

test('config files: report jobs and schedule are consistent', async () => {
	const agent = JSON.parse(await readFile(new URL('../config/agent.json', import.meta.url), 'utf8'));
	const supervisor = JSON.parse(await readFile(new URL('../config/supervisor.json', import.meta.url), 'utf8'));
	for (const kind of ['report_daily', 'report_weekly', 'report']) {
		assert.ok(agent.launcher.jobs[kind]?.tools.includes('get_report_data'), kind);
		assert.ok(!agent.launcher.jobs[kind].tools.includes('send_battery_command'), kind);
	}
	assert.equal(agent.launcher.jobs.report_daily.model, 'haiku');
	assert.equal(agent.launcher.jobs.report_weekly.model, 'sonnet');
	assert.ok(!agent.launcher.jobs.report.tools.includes('write_notes'));
	assert.doesNotThrow(() => setup({ config: supervisor.reports }));
});

// ─── MCP: get_report_data ──────────────────────────────────────────────────

const FROM = new Date(2026, 9, 1, 18, 0).getTime();
const TO = FROM + 24 * HOUR;

function hourRow(i, avg, samples = 3600) {
	return { bucket: FROM + i * HOUR, samples, avg, min: avg - 1, max: avg + 2, p95: avg + 1, maxGapS: samples ? 2 : 3600 };
}

test('summarizeMetric: weighted mean, coverage, change, peak hour, reference', () => {
	const rows = Array.from({ length: 24 }, (_, i) => hourRow(i, i === 14 ? 40 : 10));
	rows[3] = hourRow(3, null, 0);
	const hourly = summarizeMetric(rows.map((row, k) => ({ ...row, avg: 900 + k * 100 })), { fromMs: FROM, toMs: TO, reference: { value: 1000, window: 'hour', basis: 'CO2' } });
	assert.equal(hourly.reference.hoursAbove, rows.filter((row, k) => row.samples > 0 && 900 + k * 100 > 1000).length);
	assert.equal(hourly.reference.hours, rows.filter((row) => row.samples > 0).length);
	const stats = summarizeMetric(rows, { fromMs: FROM, toMs: TO, previousAvg: 8, reference: { value: 15, basis: 'OMS' } });
	const expectedAvg = (22 * 10 + 40) / 23;
	assert.equal(stats.avg, Math.round(expectedAvg * 100) / 100);
	assert.equal(stats.min, 9);
	assert.equal(stats.max, 42);
	assert.equal(stats.p95, 41);
	assert.equal(stats.coveragePct, 95.8);
	assert.equal(stats.hoursWithoutData, 1);
	assert.equal(stats.maxGapS, 2);
	assert.equal(stats.changePct, Math.round(((expectedAvg - 8) / 8) * 100));
	// Hour 14 of the period = 08:00 of the next day
	assert.deepEqual(stats.peakHour, { at: '08:00', avg: 40 });
	assert.deepEqual(stats.reference, { value: 15, basis: 'OMS', windows24h: 1, windowsAbove: 0, max24hAvg: stats.avg });
});

test('summarizeBattery and summarizeEvents', () => {
	const battery = summarizeBattery([
		{ run_state: 0, battery_type: 1, samples: 3600, v_min: 3600, v_max: 3700, sum_current: 0, first_at: new Date(FROM), last_at: new Date(FROM + HOUR) },
		{ run_state: 1, battery_type: 1, samples: 7200, v_min: 3500, v_max: 4200, sum_current: 7200 * 500, first_at: new Date(FROM + HOUR), last_at: new Date(FROM + 3 * HOUR) },
		{ run_state: 1, battery_type: 3, samples: 600, v_min: 3900, v_max: 4100, sum_current: '300000', first_at: new Date(FROM + 4 * HOUR), last_at: new Date(FROM + 5 * HOUR) },
		// Effective state from the query (run_mode): the register reads 1 in discharge
		{ run_mode: 2, battery_type: 3, samples: 1200, v_min: 3300, v_max: 3900, sum_current: -1200 * 500, first_at: new Date(FROM + 5 * HOUR), last_at: new Date(FROM + 6 * HOUR) }
	]);
	assert.equal(battery.states.scarica.minutes, 20);
	assert.equal(battery.states.scarica.chargeMahEstimate, 167);
	assert.equal(battery.states.ferma.minutes, 60);
	assert.equal(battery.states.ferma.chargeMahEstimate, undefined);
	assert.deepEqual(battery.states.carica.voltageMv, [3500, 4200]);
	assert.equal(battery.states.carica.minutes, 130);
	assert.equal(battery.states.carica.chargeMahEstimate, 1083);
	assert.deepEqual(battery.batteryTypeMinutes, { 1: 180, 3: 30 });

	const events = summarizeEvents([
		{ event_key: 'lab:pm2_5:high', peak_severity: 'warning', n: 5n, still_open: '0', duration_s: '1800', example: 'PM2.5 alto' },
		{ event_key: 'interlock:trip', peak_severity: 'critical', n: 1n, still_open: '1', duration_s: '60', example: 'Interblocco' },
		{ event_key: 'agent:command', peak_severity: 'info', n: 2n, still_open: '0', duration_s: '0', example: 'cmd' }
	], [{ agent_status: 'handled', n: 5n }, { agent_status: 'escalated', n: 1n }], { maxGroups: 2 });
	assert.deepEqual(events.bySeverity, { critical: 1, warning: 5, info: 2 });
	assert.deepEqual(events.groups.map((g) => g.key), ['interlock:trip', 'lab:pm2_5:high']);
	assert.equal(events.groups[1].totalMin, 30);
	assert.equal(events.omittedGroups, 1);
	assert.deepEqual(events.triage, { handled: 5, escalated: 1 });
});

function routedDb({ batteryError = false } = {}) {
	const calls = [];
	return {
		calls,
		async query(sql, params, options) {
			calls.push({ sql, params, options });
			if (sql.includes('FROM summary_hour') && sql.includes('ORDER BY bucket_start')) {
				return [
					{ bucket_start: new Date(FROM), source: 'lab', metric: 'pm2_5', samples: 3600, avg_value: 20, min_value: 10, max_value: 30, p95_value: 28, max_gap_s: 1 },
					{ bucket_start: new Date(FROM), source: 'battery', metric: 'voltage_measured_mv', samples: 3600, avg_value: 3700, min_value: 3690, max_value: 3710, p95_value: 3705, max_gap_s: 1 }
				];
			}
			if (sql.includes('FROM summary_hour')) return [{ source: 'lab', metric: 'pm2_5', avg_value: 10 }];
			if (sql.includes('GROUP BY agent_status')) return [];
			if (sql.includes('FROM supervisor_events')) return [];
			if (batteryError) throw Object.assign(new Error('timeout'), { sqlMessage: 'Query execution was interrupted' });
			return [];
		}
	};
}

test('buildReportData: sections, previous period, battery failure isolated', async () => {
	const db = routedDb({ batteryError: true });
	const data = await buildReportData({ db, fromMs: FROM, toMs: TO, references: { pm2_5: { value: 15, basis: 'OMS' } }, batteryTable: 'battery_measurements' });
	assert.equal(data.period.from, '2026-10-01 18:00');
	assert.equal(data.period.comparedWith, '2026-09-30 18:00 → 2026-10-01 18:00');
	assert.equal(data.lab.pm2_5.avg, 20);
	assert.equal(data.lab.pm2_5.changePct, 100);
	assert.equal(data.lab.pm2_5.reference.windowsAbove, 1);
	assert.equal(data.battery.voltage_measured_mv.avg, 3700);
	assert.equal(data.battery.voltage_measured_mv.reference, undefined);
	assert.match(data.battery.activity.error, /interrupted/);
	assert.equal(data.events.groups.length, 0);
	assert.ok(db.calls.some((c) => c.sql.includes('FROM battery_measurements')));
});

test('get_report_data: whole hours, range limits', async () => {
	const NOW = new Date(2026, 9, 2, 18, 3).getTime();
	const db = routedDb();
	const tools = createTools({ db, bus: null, notes: null, now: () => NOW, config: { reports: { maxDays: 8, references: {} } } });
	const data = await tools.get_report_data({});
	assert.equal(data.period.from, '2026-10-01 18:00');
	assert.equal(data.period.to, '2026-10-02 18:00');
	await assert.rejects(tools.get_report_data({ from: '-10d' }), /troppo lungo/);
	await assert.rejects(tools.get_report_data({ from: '-2m' }), /ora intera/);
	assert.throws(() => createTools({ db, config: {}, batteryTable: 'x; DROP' }), /Invalid table/);
});
