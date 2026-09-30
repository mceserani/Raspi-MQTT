import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentLink, formatAudit } from '../supervisor/agent-link.js';
import { checkReadonlySql, compactRows, parseTime } from '../mcp/format.js';
import { NotesStore } from '../mcp/notes.js';
import { createTools } from '../mcp/tools.js';
import { silentLog } from './helpers.js';

const NOW = new Date(2026, 8, 30, 12, 0, 0).getTime();
const LIMITS = { vMin: 3000, vMax: 4230, iChargeMax: 1300, iDischargeMax: 2600, tempMax: 45, maxPhaseDuration: 28800 };
const config = {
	commands: { voltageMarginMv: 30, currentMarginPct: 5, temperatureMarginC: 5, temperatureMaxAgeSeconds: 60, batteryMaxAgeSeconds: 10, ackTimeoutSeconds: 1, maxPerMinute: 2 },
	status: { maxAgeSeconds: 20, waitSeconds: 0 },
	queries: { maxRows: 3, maxCellChars: 10, maxResultChars: 1000 },
	summary: { maxBuckets: 100 },
	events: { defaultLimit: 50, maxLimit: 200 },
	telegram: { maxChars: 50 },
	notes: { maxBytes: 200 }
};

function makeStatus() {
	return {
		online: true,
		at: new Date(NOW - 1000).toISOString(),
		uptimeSeconds: 7200,
		live: {
			lab: { pm2_5: { value: 7.123, ageSeconds: 1, invalid: false }, ntc_temperature: { value: 24, ageSeconds: 1, invalid: false } },
			battery: { runState: 0, voltageMeasuredMv: 3700, currentMeasuredMa: 0, voltageSetpointMv: 4200, currentSetpointMa: 800, batteryType: 0, ageSeconds: 1 }
		},
		profile: { name: 'liion', source: 'manual', usable: true, reasons: [], limits: LIMITS },
		interlock: { armed: true, latched: null },
		openEvents: [{ key: 'lab:pm', severity: 'warning', message: 'PM alto', openedAt: NOW - 60000 }],
		health: { at: new Date(NOW).toISOString(), services: { mariadb: { state: 'active', errors: 0, warnings: 1 } } },
		databaseReady: true
	};
}

function fakeBus({ status = makeStatus(), ack = { status: 'ok', message: 'applied' } } = {}) {
	return {
		connected: true,
		sent: [],
		published: [],
		async getStatus() {
			return { status, receivedAt: NOW };
		},
		async sendBatteryCommand(command) {
			this.sent.push(command);
			return ack ? { commandId: 'agent-1', ack } : { commandId: 'agent-1', timeout: true };
		},
		async publishToSupervisor(kind, payload) {
			this.published.push({ kind, payload });
		}
	};
}

function fakeDb(rows = []) {
	return {
		calls: [],
		async query(sql, params, options) {
			this.calls.push({ sql, params, options });
			return rows;
		}
	};
}

const toolsWith = (deps) => createTools({ config, now: () => NOW, notes: null, db: fakeDb(), bus: fakeBus(), ...deps });

test('read-only SQL guard', () => {
	assert.equal(checkReadonlySql('SELECT * FROM summary_hour;').ok, true);
	assert.equal(checkReadonlySql('with x as (select 1) select * from x').ok, true);
	assert.equal(checkReadonlySql('SELECT 1; DROP TABLE x').ok, false);
	assert.equal(checkReadonlySql('DELETE FROM supervisor_events').ok, false);
	assert.equal(checkReadonlySql('SELECT * FROM t INTO OUTFILE "/tmp/x"').ok, false);
	assert.equal(checkReadonlySql('SELECT SLEEP(100)').ok, false);
	assert.equal(checkReadonlySql('SELECT 1 -- x').ok, false);
});

test('time parsing: relative and local', () => {
	assert.equal(parseTime('-30m', NOW), NOW - 1800000);
	assert.equal(parseTime('-2h', NOW), NOW - 7200000);
	assert.equal(parseTime('-7d', NOW), NOW - 7 * 86400000);
	assert.equal(parseTime('now', NOW), NOW);
	assert.equal(parseTime('2026-09-30 10:00', NOW), new Date(2026, 8, 30, 10, 0).getTime());
	assert.throws(() => parseTime('ieri', NOW));
});

test('compactRows: columns, BigInt, dates, caps', () => {
	const rows = [1, 2, 3, 4].map((i) => ({ id: BigInt(i), at: new Date(2026, 8, 30, 12, 0, i), text: 'x'.repeat(20) }));
	const result = compactRows(rows, config.queries);
	assert.deepEqual(result.columns, ['id', 'at', 'text']);
	assert.deepEqual(result.rows[0], [1, '2026-09-30 12:00:01', `${'x'.repeat(10)}…`]);
	assert.equal(result.rowCount, 3);
	assert.equal(result.truncated, true);
});

test('get_live_status: compact view with command bounds', async () => {
	const result = await toolsWith({}).get_live_status();
	assert.equal(result.lab.pm2_5.value, 7.12);
	assert.equal(result.battery.state, 'ferma');
	assert.equal(result.profile.commandBounds.voltageMaxMv, 4200);
	assert.equal(result.interlock.state, 'armato');
	assert.equal(result.openEvents.length, 1);
});

test('get_live_status fails when the supervisor is offline or stale', async () => {
	await assert.rejects(toolsWith({ bus: fakeBus({ status: { online: false } }) }).get_live_status(), /non raggiungibile/);
	const old = makeStatus();
	old.at = new Date(NOW - 120000).toISOString();
	await assert.rejects(toolsWith({ bus: fakeBus({ status: old }) }).get_live_status(), /vecchio/);
});

test('get_summary: auto granularity, metric check, point cap', async () => {
	const db = fakeDb([{ bucket: new Date(2026, 8, 30, 11, 0), source: 'lab', metric: 'pm2_5', samples: 60, avg_value: 7.126, min_value: 5, max_value: 9, p95_value: 8.5, max_gap_s: 2 }]);
	const tools = toolsWith({ db });
	const result = await tools.get_summary({ from: '-1h', metrics: ['pm2_5'], source: 'lab' });
	assert.equal(result.granularity, 'minute');
	assert.deepEqual(result.series['lab.pm2_5'][0], ['2026-09-30 11:00', 60, 7.13, 5, 9, 8.5, 2]);
	assert.match(db.calls[0].sql, /FROM summary_minute/);

	await tools.get_summary({ from: '-7d', metrics: ['pm2_5'] });
	assert.match(db.calls[1].sql, /FROM summary_hour .*GROUP BY DATE/s);
	await assert.rejects(tools.get_summary({ metrics: ['co2'] }), /sconosciute/);
	await assert.rejects(tools.get_summary({ from: '-2d', granularity: 'minute' }), /troppi punti/);
});

test('query_readonly refuses writes before reaching the database', async () => {
	const db = fakeDb();
	await assert.rejects(toolsWith({ db }).query_readonly({ sql: 'UPDATE x SET a = 1' }), /rifiutata/);
	assert.equal(db.calls.length, 0);
});

test('send_battery_command: executed, audited, rate limited', async () => {
	const bus = fakeBus();
	const tools = toolsWith({ bus });
	const result = await tools.send_battery_command({ command: 'set_current_ma', value: 500, reason: 'prova' });
	assert.equal(result.executed, true);
	assert.equal(bus.published[0].kind, 'audit');
	assert.equal(bus.published[0].payload.outcome, 'ok');

	await tools.send_battery_command({ command: 'set_current_ma', value: 600, reason: 'prova' });
	await assert.rejects(tools.send_battery_command({ command: 'set_current_ma', value: 700, reason: 'prova' }), /limite/);
	// The stop is never rate limited
	assert.equal((await tools.send_battery_command({ command: 'set_run_state', value: 0, reason: 'stop' })).executed, true);
});

test('send_battery_command: rejection is audited and nothing is sent', async () => {
	const bus = fakeBus();
	const result = await toolsWith({ bus }).send_battery_command({ command: 'set_voltage_mv', value: 4300, reason: 'prova' });
	assert.equal(result.executed, false);
	assert.match(result.rejected, /fuori/);
	assert.equal(bus.sent.length, 0);
	assert.equal(bus.published[0].payload.outcome, 'rejected');
});

test('send_battery_command: missing ack is reported as timeout', async () => {
	const result = await toolsWith({ bus: fakeBus({ ack: null }) }).send_battery_command({ command: 'set_current_ma', value: 500, reason: 'prova' });
	assert.equal(result.executed, false);
	assert.equal(result.outcome, 'timeout');
});

test('send_telegram: length cap and delivery to the supervisor', async () => {
	const bus = fakeBus();
	const tools = toolsWith({ bus });
	await tools.send_telegram({ text: 'Report pronto' });
	assert.deepEqual(bus.published[0], { kind: 'telegram', payload: { text: 'Report pronto', level: 'info' } });
	await assert.rejects(tools.send_telegram({ text: 'x'.repeat(60) }), /troppo lungo/);
});

test('notes: append, list, size cap, safe names', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'notes-'));
	try {
		const tools = toolsWith({ notes: new NotesStore(dir, { maxBytes: 200, now: () => NOW }) });
		await tools.write_notes({ name: 'osservazioni', content: 'PM alto al mattino' });
		const { content } = await tools.read_notes({ name: 'osservazioni' });
		assert.match(content, /## 2026-09-30 12:00\n\nPM alto al mattino/);
		assert.equal((await tools.read_notes({})).notes[0].name, 'osservazioni');
		await assert.rejects(tools.write_notes({ name: 'osservazioni', content: 'x'.repeat(300) }), /supererebbe/);
		await assert.rejects(tools.write_notes({ name: '../fuori', content: 'x' }), /non valido/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('AgentLink: audit always notified, agent messages limited per hour', () => {
	const sent = [];
	const recorded = [];
	const link = new AgentLink({
		bot: { send: (text) => sent.push(text) },
		events: { record: (event) => recorded.push(event) },
		config: { agentMaxMessagesPerHour: 2 },
		log: silentLog,
		now: () => NOW
	});

	link.handle('audit', { command: 'set_run_state', value: 1, outcome: 'rejected', message: 'interblocco scattato', reason: 'test' });
	assert.equal(recorded[0].type, 'command_rejected');
	assert.equal(recorded[0].severity, 'info');
	assert.match(sent[0], /rifiutato/);

	link.handle('telegram', { text: 'uno' });
	link.handle('telegram', { text: 'due', level: 'warning' });
	link.handle('telegram', { text: 'tre' });
	assert.equal(sent[2], '🤖 ⚠️ due');
	assert.match(sent[3], /superato 2 messaggi/);
	assert.equal(sent.length, 4);
	assert.match(formatAudit({ command: 'set_current_ma', value: 5, outcome: 'timeout', message: 'nessuna conferma' }), /non riuscito/);
});
