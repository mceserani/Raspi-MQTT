import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Aggregator, bucketize, floorToBucket, sourcesFor } from '../supervisor/aggregator.js';
import { createCommandHandler, formatStatus } from '../supervisor/commands.js';
import { decodeLabValue, labSensorName } from '../supervisor/decode.js';
import { EventManager } from '../supervisor/events.js';
import { countJournalIssues, HealthMonitor } from '../supervisor/health.js';
import { percentile, summarize } from '../supervisor/stats.js';
import { Notifier, TelegramBot } from '../supervisor/telegram.js';
import { labsensEncode } from '../tools/simulator.js';
import { loadConfig, silentLog } from './helpers.js';

const config = await loadConfig();

// ─── decode / stats ────────────────────────────────────────────────────────
test('decode undoes the labsens sign bug only on temperatures', () => {
	assert.equal(decodeLabValue('temperature', labsensEncode(-1.5, 100)), -1.5);
	assert.equal(decodeLabValue('ntc_temperature', labsensEncode(-0.5, 10)), -0.5);
	assert.equal(decodeLabValue('temperature', 21.37), 21.37);
	assert.equal(decodeLabValue('pm10', 400), 400, 'PM above 327 stays positive');
	assert.equal(labSensorName('sensors/lab/ntc/temperature', {}), 'ntc_temperature');
	assert.equal(labSensorName('sensors/lab/pm2_5', { sensor: 'pm2_5' }), 'pm2_5');
});

test('summarize: statistics and gaps', () => {
	const samples = [1, 2, 3, 4, 100].map((v, i) => ({ t: (i + 1) * 1000, v }));
	const s = summarize(samples, 0, 60_000);
	assert.equal(s.samples, 5);
	assert.equal(s.avg, 22);
	assert.equal(s.min, 1);
	assert.equal(s.max, 100);
	assert.equal(s.p95, 100);
	assert.equal(s.maxGapS, 55, 'from the last sample to the end of the bucket');
	assert.equal(summarize([], 0, 60_000).maxGapS, 60);
	assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
});

// ─── aggregator ────────────────────────────────────────────────────────────
test('bucketize writes a row per bucket and metric, empty buckets included', () => {
	const source = sourcesFor({ lab: 'labsens_measurements', battery: 'battery_measurements' })[0];
	const from = floorToBucket(Date.now(), 60_000) - 120_000;
	const rows = [
		{ recorded_at: new Date(from + 1000), temperature: labsensEncode(-2, 100), humidity: 40, pm10: 1, pm2_5: 1, voc: 1, nox: 1, ntc_temperature: 20 },
		{ recorded_at: new Date(from + 2000), temperature: -1, humidity: 50, pm10: 1, pm2_5: 1, voc: 1, nox: null, ntc_temperature: 20 }
	];
	const summaries = bucketize(rows, source, from, from + 120_000, 60_000);
	assert.equal(summaries.length, 2 * source.columns.length);
	const temperature = summaries.find((s) => s.bucketStart === from && s.metric === 'temperature');
	assert.equal(temperature.min, -2, 'sign fixed before summarizing');
	assert.equal(summaries.find((s) => s.bucketStart === from && s.metric === 'nox').samples, 1);
	assert.equal(summaries.find((s) => s.bucketStart === from + 60_000 && s.metric === 'humidity').samples, 0);
});

test('Aggregator processes complete buckets only and advances its cursor', async () => {
	const now = floorToBucket(Date.now(), 3_600_000) + 30 * 60_000 + 30_000;
	const queries = [];
	const db = {
		ready: true,
		async query(sql, params) {
			queries.push({ sql, params });
			return [];
		}
	};
	const stateMap = new Map();
	const state = { get: (k, d = null) => (stateMap.has(k) ? stateMap.get(k) : d), set: async (k, v) => stateMap.set(k, v) };
	const aggregator = new Aggregator({ db, state, config: { lagSeconds: 15, backfillHours: 2 }, tables: { lab: 'l', battery: 'b' }, log: silentLog, now: () => now });

	await aggregator.run();
	assert.equal(stateMap.get('aggregation.minute.cursor'), floorToBucket(now - 15_000, 60_000));
	assert.equal(stateMap.get('aggregation.hour.cursor'), floorToBucket(now, 3_600_000));
	assert.ok(queries.some((q) => q.sql.includes('INSERT INTO summary_minute')));
	assert.ok(queries.some((q) => q.sql.includes('INSERT INTO summary_hour')));

	queries.length = 0;
	await aggregator.run();
	assert.equal(queries.length, 0, 'nothing new to do');
});

test('Aggregator refuses unsafe table names', () => {
	assert.throws(() => new Aggregator({ db: {}, state: {}, config: {}, tables: { lab: 'x; DROP', battery: 'b' } }));
});

// ─── events ────────────────────────────────────────────────────────────────
function fakeStore() {
	const ops = [];
	return { ops, insert: (e) => ops.push(['insert', e.key]), update: (e) => ops.push(['update', e.key, e.severity]), resolve: (e) => ops.push(['resolve', e.key]) };
}

test('EventManager: open, escalate, resolve, one-shot', () => {
	const store = fakeStore();
	const notified = [];
	const manager = new EventManager({ store, notifier: { notify: (e, kind) => notified.push([kind, e.key]) } });
	const c = (severity) => ({ key: 'k', source: 's', type: 't', severity, message: 'm', details: {} });

	manager.sync([c('warning')], 1);
	manager.sync([c('warning')], 2);
	manager.sync([c('critical')], 3);
	manager.sync([c('warning')], 4);
	manager.sync([], 5);
	manager.record(c('warning'), 6);

	assert.deepEqual(store.ops, [['insert', 'k'], ['update', 'k', 'critical'], ['update', 'k', 'warning'], ['resolve', 'k'], ['insert', 'k']]);
	assert.deepEqual(notified.map(([kind]) => kind), ['open', 'escalated', 'resolved', 'oneshot']);
});

// ─── telegram ──────────────────────────────────────────────────────────────
test('Notifier: minimum severity, silent, resolved, rate limit with critical bypass', () => {
	const sent = [];
	let now = 0;
	const notifier = new Notifier({ bot: { send: (text) => sent.push(text) }, config: { notifyMinSeverity: 'warning', notifyResolved: true, maxMessagesPerMinute: 2 }, log: silentLog, now: () => now });
	const e = (severity) => ({ key: 'k', severity, peakSeverity: severity, message: severity });

	notifier.notify(e('info'), 'open');
	assert.equal(sent.length, 0);
	notifier.notify({ ...e('warning'), silent: true }, 'oneshot');
	assert.equal(sent.length, 0, 'silent: already sent by its source');
	notifier.notify(e('warning'), 'open');
	notifier.notify(e('warning'), 'resolved');
	notifier.notify(e('warning'), 'open');
	assert.equal(sent.length, 2, 'third one held back');
	notifier.notify(e('critical'), 'open');
	assert.equal(sent.length, 3, 'critical always sent');
	now = 61_000;
	notifier.tick();
	assert.match(sent.at(-1), /1 notifiche non inviate/);
});

test('TelegramBot accepts commands only from the authorized chat', async () => {
	const calls = [];
	const fetchImpl = async (url, options) => {
		calls.push({ method: url.split('/').pop(), body: JSON.parse(options.body) });
		return { json: async () => ({ ok: true, result: {} }) };
	};
	const bot = new TelegramBot({ token: 't', chatId: '42', fetchImpl, log: silentLog });
	const received = [];
	const onCommand = async (command, args) => {
		received.push([command, args]);
		return 'ok';
	};

	await bot.handleUpdate({ message: { chat: { id: 7 }, text: '/stop' } }, onCommand);
	assert.equal(received.length, 0);
	await bot.handleUpdate({ message: { chat: { id: 42 }, text: '/battery@mybot liion' } }, onCommand);
	assert.deepEqual(received, [['battery', ['liion']]]);
	assert.equal(calls.at(-1).body.chat_id, '42');

	const unconfigured = new TelegramBot({ token: 't', chatId: null, fetchImpl, log: silentLog });
	await unconfigured.handleUpdate({ message: { chat: { id: 99 }, text: '/status' } }, onCommand);
	assert.match(calls.at(-1).body.text, /chat_id è 99/);
	assert.equal(received.length, 1);
});

// ─── commands ──────────────────────────────────────────────────────────────
function statusFixture(overrides = {}) {
	return {
		uptimeSeconds: 3700,
		live: { lab: { temperature: { value: 22.4, ageSeconds: 1 } }, battery: { runState: 1, voltageMeasuredMv: 3655, currentMeasuredMa: 499, voltageSetpointMv: 4200, currentSetpointMa: 500, batteryType: 0, ageSeconds: 1 } },
		profile: { name: null, usable: false, reasons: ['no profile for this battery'] },
		interlock: { latched: null },
		openEvents: [],
		health: null,
		databaseReady: true,
		...overrides
	};
}

test('formatStatus shows the essentials', () => {
	const text = formatStatus(statusFixture());
	assert.match(text, /T 22.4 °C/);
	assert.match(text, /carica · 3655 mV \/ 499 mA/);
	assert.match(text, /solo osservazione/);
	assert.match(text, /Eventi aperti: nessuno/);
});

test('command handler: stop, battery, reset', async () => {
	let manual = null;
	let latched = { at: new Date().toISOString(), reasons: ['x'] };
	const handler = createCommandHandler({
		status: () => statusFixture({ interlock: { latched } }),
		stop: async () => ({ stopped: true }),
		openEvents: () => [],
		now: () => Date.now(),
		profiles: () => ({ names: ['liion'], active: { name: manual, usable: false, reasons: ['r'] }, manual }),
		setManualProfile: async (name) => {
			if (name === 'nope') return { ok: false, message: 'Profilo sconosciuto: nope' };
			manual = name;
			return { ok: true, active: { name, source: 'manual', usable: false, reasons: ['r'] } };
		},
		resetInterlock: async () => {
			latched = null;
		}
	});

	assert.match(await handler('stop', []), /ferma/);
	assert.match(await handler('battery', []), /Profili disponibili: liion/);
	assert.match(await handler('battery', ['liion']), /liion \(dichiarato\)/);
	assert.match(await handler('battery', ['nope']), /sconosciuto/);
	assert.match(await handler('reset', []), /riarmato/);
	assert.match(await handler('reset', []), /non è scattato/);
	assert.match(await handler('boh', []), /Comando sconosciuto/);
});

// ─── health ────────────────────────────────────────────────────────────────
test('journal counting and service states', async () => {
	assert.deepEqual(countJournalIssues('[INFO] a\n[ERROR] b\n[CMD ERROR] c\n[WARN] d\n[FATAL] e'), { errors: 3, warnings: 1 });

	const exec = async (command, args) => {
		if (command === 'systemctl') return 'active\ninactive\nactive\nactive\nfailed\n';
		return args[1] === 'raspi-labsens.service' ? '[ERROR] x\n'.repeat(25) : '';
	};
	const monitor = new HealthMonitor(config.health, { exec, log: silentLog, enabled: true });
	const conditions = await monitor.check();
	const keys = conditions.map((c) => c.key).sort();
	assert.deepEqual(keys, ['health:errors:raspi-labsens', 'health:inactive:mosquitto', 'health:inactive:raspi-battery']);
	assert.equal(conditions.find((c) => c.key === 'health:inactive:raspi-battery').severity, 'critical');
	assert.equal(monitor.last.services['raspi-labsens'].errors, 25);
});
