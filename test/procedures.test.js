import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeStep, ProcedureRunner, validateProcedure } from '../supervisor/procedures.js';
import { createCommandHandler } from '../supervisor/commands.js';
import { validateBatteryCommand } from '../mcp/validation.js';
import { createTools } from '../mcp/tools.js';
import { silentLog } from './helpers.js';

const T0 = new Date(2026, 9, 3, 9, 0).getTime();
const LIMITS = { vMin: 3000, vMax: 4230, iChargeMax: 1300, iDischargeMax: 2600, tempMax: 45, maxPhaseDuration: 28800 };
const CONFIG = { enabled: true, voltageMarginMv: 30, currentMarginPct: 5, temperatureMarginC: 5, batteryMaxAgeSeconds: 10, temperatureMaxAgeSeconds: 60, ackTimeoutSeconds: 10, confirmTimeoutSeconds: 20, settleSeconds: 20, confirmSamples: 5, staleSeconds: 30, phaseMarginMinutes: 5, maxRepeat: 10, maxSteps: 50, maxTotalHours: 72, maxRestMinutes: 1440 };

const CHARGE = { type: 'charge', currentMa: 1000, voltageMv: 4200, maxMinutes: 60, until: { currentBelowMa: 100 } };
const DISCHARGE = { type: 'discharge', currentMa: 1000, voltageMv: 3100, maxMinutes: 60, until: { voltageBelowMv: 3300 } };
const REST = { type: 'rest', minutes: 2 };

test('validation: steps, limits of the profile, repeat and total duration', () => {
	const ok = validateProcedure({ name: 'Ciclo', steps: [CHARGE, REST, DISCHARGE], repeat: 2 }, { limits: LIMITS, config: CONFIG });
	assert.equal(ok.ok, true);
	assert.equal(ok.steps.length, 6);
	assert.equal(ok.maxMinutes, 2 * (60 + 2 + 60));

	const refuse = (spec) => validateProcedure({ name: 'x', ...spec }, { limits: LIMITS, config: CONFIG }).reason;
	assert.match(refuse({ steps: [] }), /da 1 a 10 passi/);
	assert.match(refuse({ steps: [{ ...CHARGE, currentMa: 1300 }] }), /currentMa intero da 1 a 1235 mA per la carica/);
	assert.match(refuse({ steps: [{ ...DISCHARGE, currentMa: 2500 }] }), /da 1 a 2470 mA per la scarica/);
	assert.match(refuse({ steps: [{ ...CHARGE, voltageMv: 4220 }] }), /voltageMv intero da 3030 a 4200/);
	assert.match(refuse({ steps: [{ ...CHARGE, maxMinutes: 600 }] }), /maxMinutes da 1 a 475/);
	assert.match(refuse({ steps: [{ ...CHARGE, maxMinutes: undefined }] }), /maxMinutes/);
	assert.match(refuse({ steps: [{ ...CHARGE, until: { voltageAboveMv: 4210 } }] }), /oltre il setpoint/);
	assert.match(refuse({ steps: [{ ...CHARGE, until: { voltageBelowMv: 3500 } }] }), /condizioni non previste per la carica: voltageBelowMv/);
	assert.match(refuse({ steps: [{ ...CHARGE, until: { currentBelowMa: 1000 } }] }), /sotto il setpoint/);
	assert.match(refuse({ steps: [{ ...DISCHARGE, until: { voltageBelowMv: 3000 } }] }), /voltageBelowMv intero dal setpoint 3100 .*sotto il setpoint non si raggiunge/);
	assert.match(refuse({ steps: [{ ...REST, currentMa: 5 }] }), /campi non previsti currentMa/);
	assert.match(refuse({ steps: [{ type: 'pulse' }] }), /type deve essere/);
	assert.match(refuse({ steps: [CHARGE], repeat: 11 }), /repeat/);
	assert.match(refuse({ steps: [{ ...CHARGE, maxMinutes: 470 }, { ...DISCHARGE, maxMinutes: 470 }], repeat: 5 }), /oltre il limite di 72 h/);
	assert.match(validateProcedure({ steps: [CHARGE] }, { limits: LIMITS, config: CONFIG }).reason, /name/);
	assert.equal(describeStep(CHARGE), 'carica 1000 mA / 4200 mV fino a |I| ≤ 100 mA o 60 min');
});

// Simulated bench: charge rises 2 mV/s up to the setpoint, then the current
// tapers by 5 %/s; discharge drops 2 mV/s. One sample per second. Like the real
// bench, it does not start a charge at or above the voltage setpoint, nor a
// discharge at or below it.
function bench({ v0 = 3700, latched = null, ntc = 25, ackOk = true, profileUsable = true } = {}) {
	const sim = { t: T0, at: T0, state: { runState: 0, currentSetpointMa: 500, voltageSetpointMv: 4200, currentMeasuredMa: 0, voltageMeasuredMv: v0 }, latched, frozen: false };
	const notified = [];
	const events = [];
	const commands = [];
	const stops = [];
	const store = { inserted: [], updated: [], insert(p) { this.inserted.push(p.id); }, update(p) { this.updated.push(p); } };
	const values = new Map();
	const hooks = [];
	const physics = () => {
		const s = sim.state;
		if (s.runState === 1) {
			if (s.voltageMeasuredMv < s.voltageSetpointMv) {
				s.currentMeasuredMa = s.currentSetpointMa;
				s.voltageMeasuredMv = Math.min(s.voltageSetpointMv, s.voltageMeasuredMv + 2);
			} else {
				s.currentMeasuredMa = Math.round(s.currentMeasuredMa * 0.95);
			}
		} else if (s.runState === 2) {
			s.currentMeasuredMa = -s.currentSetpointMa;
			s.voltageMeasuredMv -= 2;
		} else {
			s.currentMeasuredMa = 0;
		}
	};
	const runner = new ProcedureRunner({
		config: CONFIG,
		store,
		state: { get: (k) => values.get(k) ?? null, set: async (k, v) => values.set(k, v) },
		log: silentLog,
		now: () => sim.t,
		sleep: async (ms) => {
			sim.t += ms;
			if (!sim.frozen) {
				physics();
				sim.at = sim.t;
			}
			for (const hook of hooks) hook(sim);
		},
		io: {
			async command(command, value) {
				commands.push([command, value]);
				if (!ackOk) return { ok: false, message: 'timeout' };
				if (command === 'set_current_ma') sim.state.currentSetpointMa = value;
				if (command === 'set_voltage_mv') sim.state.voltageSetpointMv = value;
				if (command === 'set_run_state') {
					const { voltageMeasuredMv: v, voltageSetpointMv: sp } = sim.state;
					if (value === 0 || (value === 1 && v < sp) || (value === 2 && v > sp)) sim.state.runState = value;
				}
				return { ok: true };
			},
			stop: (source) => {
				stops.push(source);
				sim.state.runState = 0;
			},
			battery: () => ({ state: { ...sim.state }, at: sim.at }),
			context: () => ({
				profile: profileUsable ? { name: 'liion', usable: true, profile: { limits: LIMITS } } : { name: null, usable: false, reasons: ['no profile for this battery'] },
				latched: sim.latched,
				ntc: ntc === null ? null : { value: ntc, at: sim.t }
			}),
			notify: (text) => notified.push(text),
			event: (event) => events.push(event),
			finished: (result) => { sim.finished = result; }
		}
	});
	return { runner, sim, notified, events, commands, stops, store, values, hooks };
}

test('runner: charge to taper, rest, discharge to voltage; results and notifications', async () => {
	const b = bench();
	const started = b.runner.start({ name: 'Ciclo breve', steps: [CHARGE, REST, DISCHARGE] }, { requestedBy: 'agent', reason: 'richiesta utente' });
	assert.equal(started.ok, true);
	assert.equal(started.id, 'P20261003-090000');
	assert.equal(b.runner.snapshot().step, 1);
	assert.match(b.notified[0], /^▶️ Procedura P20261003-090000 avviata \(agent\): Ciclo breve — 3 passi, al massimo 2 h/);
	assert.deepEqual(b.values.get('procedure.running').id, started.id);
	await b.runner.done;

	assert.equal(b.runner.running, false);
	assert.deepEqual(b.commands.slice(0, 3), [['set_current_ma', 1000], ['set_voltage_mv', 4200], ['set_run_state', 1]]);
	assert.deepEqual(b.commands.filter(([c]) => c === 'set_run_state').map(([, v]) => v), [1, 0, 2, 0]);
	assert.deepEqual(b.stops, []);
	const final = b.store.updated.at(-1);
	assert.equal(final.status, 'completed');
	assert.deepEqual(final.results.map((r) => r.endedBy), ['currentBelowMa', 'minutes', 'voltageBelowMv']);
	// 250 s at 1000 mA, then the taper
	assert.ok(final.results[0].mAh >= 70 && final.results[0].mAh <= 80, final.results[0].mAh);
	assert.ok(final.results[2].vEndMv <= 3300);
	assert.match(b.notified.at(-1), /^✅ Procedura P20261003-090000 \(Ciclo breve\) completata: 3 passi/);
	assert.equal(b.sim.finished.status, 'completed');
	assert.equal(b.values.get('procedure.running'), null);
	assert.equal(b.events.at(-1).key, 'procedure:completed');
});

test('runner: maxMinutes ends a step that never meets its condition', async () => {
	const b = bench();
	b.runner.start({ name: 'Timeout', steps: [{ ...CHARGE, maxMinutes: 2, until: { currentBelowMa: 10 } }] });
	await b.runner.done;
	assert.equal(b.store.updated.at(-1).results[0].endedBy, 'maxMinutes');
	assert.equal(b.store.updated.at(-1).status, 'completed');
});

test('runner: stop request, interlock, external command and stale data end it with a stop', async () => {
	const stop = bench();
	stop.hooks.push((sim) => { if (sim.t === T0 + 60000) stop.runner.stop('fermata dall\'utente'); });
	stop.runner.start({ name: 'Stop', steps: [CHARGE] });
	await stop.runner.done;
	assert.equal(stop.store.updated.at(-1).status, 'stopped');
	assert.match(stop.notified.at(-1), /^⏹️ .*fermata al passo 1\/1: fermata dall'utente/);
	assert.deepEqual(stop.stops, ['procedure']);

	const trip = bench();
	trip.hooks.push((sim) => { if (sim.t === T0 + 60000) { sim.latched = { reasons: ['vMax'] }; sim.state.runState = 0; } });
	trip.runner.start({ name: 'Trip', steps: [CHARGE] });
	await trip.runner.done;
	assert.equal(trip.store.updated.at(-1).status, 'aborted');
	assert.match(trip.store.updated.at(-1).endMessage, /interblocco scattato/);
	assert.equal(trip.events.at(-1).severity, 'warning');

	const external = bench();
	external.hooks.push((sim) => { if (sim.t === T0 + 60000) sim.state.runState = 0; });
	external.runner.start({ name: 'Esterno', steps: [CHARGE] });
	await external.runner.done;
	assert.match(external.store.updated.at(-1).endMessage, /non è più in carica/);

	const stale = bench();
	stale.hooks.push((sim) => { if (sim.t === T0 + 60000) sim.frozen = true; });
	stale.runner.start({ name: 'Fermi', steps: [CHARGE] });
	await stale.runner.done;
	assert.match(stale.store.updated.at(-1).endMessage, /dati della batteria fermi/);

	const rest = bench();
	rest.hooks.push((sim) => { if (sim.t === T0 + 30000) sim.state.runState = 2; });
	rest.runner.start({ name: 'Riposo', steps: [{ type: 'rest', minutes: 5 }] });
	await rest.runner.done;
	assert.match(rest.store.updated.at(-1).endMessage, /partita durante il riposo/);
});

test('runner: refused start, failed command, restart recovery', async () => {
	assert.match(bench({ latched: { reasons: ['x'] } }).runner.start({ name: 'x', steps: [CHARGE] }).reason, /interblocco/);
	assert.match(bench({ ntc: null }).runner.start({ name: 'x', steps: [CHARGE] }).reason, /NTC/);
	assert.match(bench({ ntc: 41 }).runner.start({ name: 'x', steps: [CHARGE] }).reason, /sopra il massimo/);
	assert.match(bench({ v0: 4200 }).runner.start({ name: 'x', steps: [CHARGE] }).reason, /già al limite di carica/);
	assert.match(bench({ v0: 3700 }).runner.start({ name: 'x', steps: [{ ...CHARGE, voltageMv: 3600, until: {} }] }).reason, /già al setpoint di carica 3600 mV o sopra/);
	assert.match(bench({ v0: 3370 }).runner.start({ name: 'x', steps: [{ ...DISCHARGE, voltageMv: 4200, until: {} }] }).reason, /già al setpoint di scarica 4200 mV o sotto: il banco non scaricherebbe/);
	assert.match(bench({ profileUsable: false }).runner.start({ name: 'x', steps: [CHARGE] }).reason, /nessun profilo/);
	assert.match(bench().runner.start({ name: 'x', steps: [{ ...CHARGE, currentMa: 5000 }] }).reason, /currentMa/);

	const busy = bench();
	busy.runner.start({ name: 'Uno', steps: [REST] });
	assert.match(busy.runner.start({ name: 'Due', steps: [REST] }).reason, /già in corso/);
	await busy.runner.done;
	assert.match(busy.runner.stop().reason, /nessuna procedura/);

	// Discharge setpoint above the voltage reached after charge and rest: the
	// step is refused before any command, with the reason
	const above = bench({ v0: 3300 });
	above.runner.start({ name: 'Sopra', steps: [{ ...CHARGE, maxMinutes: 1, until: {} }, REST, { ...DISCHARGE, voltageMv: 4200, until: {} }] });
	await above.runner.done;
	assert.match(above.store.updated.at(-1).endMessage, /interrotta al passo 3\/3: avvio della scarica non possibile: tensione \d+ mV già al setpoint di scarica 4200 mV/);
	assert.ok(!above.commands.some(([command, value]) => command === 'set_run_state' && value === 2));
	assert.ok(above.events.every((event) => event.silent));
	assert.equal(above.notified.filter((text) => text.startsWith('⚠️')).length, 1);

	const nack = bench({ ackOk: false });
	nack.runner.start({ name: 'Nack', steps: [CHARGE] });
	await nack.runner.done;
	assert.match(nack.store.updated.at(-1).endMessage, /comando set_current_ma=1000 non riuscito: timeout/);
	assert.deepEqual(nack.stops, ['procedure']);

	const restart = bench();
	restart.values.set('procedure.running', { id: 'P1', name: 'Vecchia', startedAt: T0 - 60000 });
	restart.runner.recover();
	assert.deepEqual(restart.stops, ['procedure-restart']);
	assert.equal(restart.store.updated[0].status, 'aborted');
	assert.match(restart.notified[0], /riavvio del supervisore/);
	assert.equal(restart.values.get('procedure.running'), null);

	const disabled = new ProcedureRunner({ config: { enabled: false }, io: {}, store: {}, log: silentLog });
	assert.match(disabled.start({}).reason, /disattivate/);
});

test('agent commands are refused while a procedure runs, the stop is not', () => {
	const NOW = T0;
	const status = {
		at: new Date(NOW).toISOString(),
		interlock: { latched: null },
		profile: { usable: true, limits: LIMITS },
		procedure: { running: true, id: 'P1' },
		live: { battery: { runState: 1, ageSeconds: 1, currentSetpointMa: 500, voltageSetpointMv: 4200, voltageMeasuredMv: 3800 }, lab: {} }
	};
	const config = { status: { maxAgeSeconds: 20 }, commands: { voltageMarginMv: 30, currentMarginPct: 5, temperatureMarginC: 5, batteryMaxAgeSeconds: 10, temperatureMaxAgeSeconds: 60 } };
	assert.match(validateBatteryCommand({ command: 'set_current_ma', value: 400 }, { status, now: NOW, config }).reason, /procedura P1 in corso/);
	assert.equal(validateBatteryCommand({ command: 'set_run_state', value: 0 }, { status, now: NOW, config }).ok, true);
});

test('MCP tools: start, stop and list procedures through the supervisor', async () => {
	const NOW = T0;
	const requests = [];
	let reply = { ok: true, id: 'P1', steps: 3, maxMinutes: 122 };
	const bus = {
		connected: true,
		async getStatus() { return { status: { at: new Date(NOW).toISOString(), online: true, procedure: { running: true, id: 'P1', name: 'Ciclo', step: 2, steps: 3, current: 'riposo 2 min', startedAt: NOW - 600000, stepStartedAt: NOW - 60000, maxMinutes: 122 } } }; },
		async requestSupervisor(kind, payload) {
			requests.push({ kind, payload });
			return reply;
		}
	};
	const db = {
		async query(sql) {
			assert.match(sql, /FROM battery_procedures ORDER BY started_at DESC LIMIT 5/);
			return [{
				procedure_id: 'P1', started_at: new Date(NOW - 600000), ended_at: null, name: 'Ciclo', status: 'running', requested_by: 'agent', reason: 'utente',
				profile: 'liion', spec: JSON.stringify({ name: 'Ciclo', steps: [CHARGE] }), steps: JSON.stringify([{ step: 1, type: 'charge', startedAt: NOW - 600000, endedAt: NOW - 120000, endedBy: 'currentBelowMa', mAh: 80 }]), end_message: null
			}];
		}
	};
	const config = { status: { maxAgeSeconds: 20, waitSeconds: 1 } };
	const tools = createTools({ bus, db, notes: null, config, now: () => NOW });

	const started = await tools.start_procedure({ name: 'Ciclo', steps: [CHARGE, REST, DISCHARGE], reason: 'richiesta utente' });
	assert.deepEqual(started.started, true);
	assert.equal(started.maxHours, 2);
	assert.deepEqual(requests[0], { kind: 'procedure', payload: { action: 'start', spec: { name: 'Ciclo', steps: [CHARGE, REST, DISCHARGE] }, reason: 'richiesta utente' } });

	reply = { ok: false, reason: 'interblocco scattato' };
	assert.deepEqual(await tools.start_procedure({ name: 'x', steps: [CHARGE], reason: 'prova' }), { started: false, rejected: 'interblocco scattato' });
	reply = { timeout: true };
	await assert.rejects(tools.stop_procedure({ reason: 'basta' }), /nessuna risposta/);
	reply = { ok: true, id: 'P1' };
	assert.equal((await tools.stop_procedure({ reason: 'basta' })).stopping, true);

	const list = await tools.get_procedures({});
	assert.equal(list.procedures[0].results[0].endedBy, 'currentBelowMa');
	assert.equal(list.procedures[0].results[0].endedAt, '2026-10-03 08:58');
	assert.equal(list.procedures[0].spec.steps.length, 1);
});

test('Telegram /procedura and /status', async () => {
	const snapshot = { running: true, id: 'P1', name: 'Ciclo', step: 2, steps: 3, current: 'riposo 2 min', startedAt: T0 - 600000, stepStartedAt: T0 - 60000, maxMinutes: 122 };
	const handler = createCommandHandler({ procedure: () => snapshot, now: () => T0 });
	assert.equal(await handler('procedura', []), 'Procedura P1 (Ciclo): passo 2/3, riposo 2 min da 60 s · avviata 10 min fa\n/stop la interrompe e ferma la batteria.');
	const idle = createCommandHandler({ procedure: () => null, now: () => T0 });
	assert.match(await idle('procedura', []), /Nessuna procedura in corso/);
});
