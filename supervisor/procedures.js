import { commandBounds } from '../mcp/validation.js';

// Battery procedures (docs/PIANO-AGENTE.md, 5.3): the agent writes a sequence
// of steps, the supervisor validates it against the active profile and runs it
// on its own, step by step, with the same command path as the dashboards
// (command/request -> bridge -> dispatch -> ack). The interlock stays active
// on the measured values; any anomaly stops the battery and ends the procedure.

export const PROCEDURES_TABLE = `CREATE TABLE IF NOT EXISTS battery_procedures (
	procedure_id VARCHAR(32) NOT NULL,
	started_at DATETIME(3) NOT NULL,
	ended_at DATETIME(3) NULL,
	name VARCHAR(64) NOT NULL,
	status VARCHAR(16) NOT NULL,
	requested_by VARCHAR(32) NOT NULL,
	reason VARCHAR(300) NULL,
	profile VARCHAR(64) NULL,
	spec JSON NOT NULL,
	steps JSON NOT NULL,
	end_message VARCHAR(512) NULL,
	PRIMARY KEY (procedure_id),
	INDEX idx_started_at (started_at)
)`;

const MODES = { charge: 1, discharge: 2 };
const LABELS = { charge: 'carica', discharge: 'scarica', rest: 'riposo' };
const UNTIL_KEYS = {
	charge: ['voltageAboveMv', 'currentBelowMa', 'mAh'],
	discharge: ['voltageBelowMv', 'currentBelowMa', 'mAh']
};
const STEP_KEYS = {
	charge: ['type', 'currentMa', 'voltageMv', 'maxMinutes', 'until'],
	discharge: ['type', 'currentMa', 'voltageMv', 'maxMinutes', 'until'],
	rest: ['type', 'minutes']
};

const isInt = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const isNum = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

export function boundsFor(limits, config) {
	return commandBounds(limits, {
		voltageMarginMv: config.voltageMarginMv ?? 30,
		currentMarginPct: config.currentMarginPct ?? 5,
		temperatureMarginC: config.temperatureMarginC ?? 5
	});
}

// Pure check of a procedure against the limits of the active profile.
// Returns { ok: true, steps, maxMinutes } with the steps expanded by repeat,
// or { ok: false, reason }.
export function validateProcedure(spec, { limits, config }) {
	const refuse = (reason) => ({ ok: false, reason });
	if (!spec || typeof spec !== 'object') return refuse('procedura mancante');
	if (typeof spec.name !== 'string' || !spec.name.trim() || spec.name.length > 60) return refuse('name: testo di 1-60 caratteri');
	if (!Array.isArray(spec.steps) || spec.steps.length < 1 || spec.steps.length > 10) return refuse('steps: da 1 a 10 passi');
	const repeat = spec.repeat ?? 1;
	const maxRepeat = config.maxRepeat ?? 10;
	if (!isInt(repeat, 1, maxRepeat)) return refuse(`repeat: intero da 1 a ${maxRepeat}`);
	const maxSteps = config.maxSteps ?? 50;
	if (spec.steps.length * repeat > maxSteps) return refuse(`troppi passi in totale (${spec.steps.length * repeat} > ${maxSteps})`);

	const bounds = boundsFor(limits, config);
	// The interlock stops a phase after maxPhaseDuration: a step must end earlier
	const maxStepMinutes = Math.floor(limits.maxPhaseDuration / 60) - (config.phaseMarginMinutes ?? 5);
	const maxRestMinutes = config.maxRestMinutes ?? 1440;
	let minutes = 0;

	for (const [index, step] of spec.steps.entries()) {
		const at = `passo ${index + 1}`;
		if (!step || !STEP_KEYS[step.type]) return refuse(`${at}: type deve essere charge, discharge o rest`);
		const extra = Object.keys(step).filter((key) => !STEP_KEYS[step.type].includes(key));
		if (extra.length) return refuse(`${at} (${step.type}): campi non previsti ${extra.join(', ')}`);

		if (step.type === 'rest') {
			if (!isNum(step.minutes, 1, maxRestMinutes)) return refuse(`${at}: minutes da 1 a ${maxRestMinutes}`);
			minutes += step.minutes;
			continue;
		}

		const label = LABELS[step.type];
		const maxCurrent = step.type === 'charge' ? bounds.chargeCurrentMaxMa : bounds.dischargeCurrentMaxMa;
		if (!isInt(step.currentMa, 1, maxCurrent)) return refuse(`${at}: currentMa intero da 1 a ${maxCurrent} mA per la ${label}`);
		if (!isInt(step.voltageMv, bounds.voltageMinMv, bounds.voltageMaxMv)) return refuse(`${at}: voltageMv intero da ${bounds.voltageMinMv} a ${bounds.voltageMaxMv} mV`);
		if (!isNum(step.maxMinutes, 1, maxStepMinutes)) return refuse(`${at}: maxMinutes da 1 a ${maxStepMinutes} (durata massima di fase del profilo meno il margine)`);

		const until = step.until ?? {};
		if (typeof until !== 'object' || Array.isArray(until)) return refuse(`${at}: until deve essere un oggetto`);
		const unknown = Object.keys(until).filter((key) => !UNTIL_KEYS[step.type].includes(key));
		if (unknown.length) return refuse(`${at}: condizioni non previste per la ${label}: ${unknown.join(', ')} (ammesse: ${UNTIL_KEYS[step.type].join(', ')})`);
		if (until.voltageAboveMv !== undefined && !isInt(until.voltageAboveMv, bounds.voltageMinMv, step.voltageMv)) {
			return refuse(`${at}: until.voltageAboveMv intero da ${bounds.voltageMinMv} al setpoint ${step.voltageMv} mV (oltre il setpoint non si raggiunge)`);
		}
		if (until.voltageBelowMv !== undefined && !isInt(until.voltageBelowMv, step.voltageMv, bounds.voltageMaxMv)) {
			return refuse(`${at}: until.voltageBelowMv intero dal setpoint ${step.voltageMv} a ${bounds.voltageMaxMv} mV (sotto il setpoint non si raggiunge)`);
		}
		if (until.currentBelowMa !== undefined && !isInt(until.currentBelowMa, 1, step.currentMa - 1)) {
			return refuse(`${at}: until.currentBelowMa intero da 1 a ${step.currentMa - 1} mA (sotto il setpoint)`);
		}
		if (until.mAh !== undefined && !isNum(until.mAh, 1, 100000)) return refuse(`${at}: until.mAh positivo`);
		minutes += step.maxMinutes;
	}

	const maxMinutes = minutes * repeat;
	const maxTotalHours = config.maxTotalHours ?? 72;
	if (maxMinutes > maxTotalHours * 60) return refuse(`durata massima totale ${Math.round(maxMinutes / 60)} h oltre il limite di ${maxTotalHours} h`);

	const steps = [];
	for (let round = 0; round < repeat; round++) {
		for (const step of spec.steps) steps.push({ ...step, until: step.type === 'rest' ? undefined : { ...(step.until ?? {}) } });
	}
	return { ok: true, steps, maxMinutes };
}

export function describeStep(step) {
	if (step.type === 'rest') return `riposo ${step.minutes} min`;
	const until = Object.entries(step.until ?? {}).map(([key, value]) => ({
		voltageAboveMv: `V ≥ ${value} mV`, voltageBelowMv: `V ≤ ${value} mV`, currentBelowMa: `|I| ≤ ${value} mA`, mAh: `${value} mAh`
	})[key]);
	return `${LABELS[step.type]} ${step.currentMa} mA / ${step.voltageMv} mV fino a ${[...until, `${step.maxMinutes} min`].join(' o ')}`;
}

class Abort extends Error {
	constructor(message, status = 'aborted') {
		super(message);
		this.status = status;
	}
}

const pad = (n) => String(n).padStart(2, '0');
function procedureId(ms) {
	const d = new Date(ms);
	return `P${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// io: command(command, value) -> Promise<{ ok, message }> through the bridge;
//     stop(source) straight to dispatch; battery() -> { state, at } | null;
//     context() -> { profile, latched, ntc: { value, at } | null };
//     notify(text); event(oneShot), marked silent: the runner notifies Telegram itself;
//     finished(procedure)
// store: insert(procedure), update(procedure) (best effort, never awaited by the loop)
export class ProcedureRunner {
	constructor({ config, io, store, state, log = console, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
		this.config = config ?? { enabled: false };
		this.io = io;
		this.store = store;
		this.state = state;
		this.log = log;
		this.now = now;
		this.sleep = sleep;
		this.current = null;
		this.stopRequest = null;
		this.done = null;
	}

	get running() {
		return Boolean(this.current);
	}

	snapshot() {
		const p = this.current;
		if (!p) return null;
		const step = p.steps[p.index];
		return {
			running: true,
			id: p.id,
			name: p.name,
			requestedBy: p.requestedBy,
			startedAt: p.startedAt,
			step: p.index + 1,
			steps: p.steps.length,
			current: step ? describeStep(step) : null,
			stepStartedAt: p.stepStartedAt,
			maxMinutes: p.maxMinutes
		};
	}

	// Pre-start checks on the live state, also repeated before every active step
	checkReady(step) {
		const c = this.config;
		const { profile, latched, ntc } = this.io.context();
		const battery = this.io.battery();
		const now = this.now();
		if (latched) return 'interblocco scattato: serve /reset dall\'utente';
		if (!profile?.usable) return `nessun profilo batteria utilizzabile (${profile?.reasons?.join(', ') ?? 'profilo assente'})`;
		if (!battery || now - battery.at > (c.batteryMaxAgeSeconds ?? 10) * 1000) return 'dati della batteria assenti o vecchi';
		if (battery.state.runState !== 0) return 'la batteria non è ferma';
		const bounds = boundsFor(profile.profile.limits, c);
		if (!ntc || now - ntc.at > (c.temperatureMaxAgeSeconds ?? 60) * 1000) return 'temperatura NTC non disponibile';
		if (ntc.value > bounds.temperatureMaxC) return `temperatura NTC ${ntc.value} °C sopra il massimo per l'avvio (${bounds.temperatureMaxC} °C)`;
		const v = battery.state.voltageMeasuredMv;
		if (step?.type === 'charge' && v >= bounds.voltageMaxMv) return `tensione ${v} mV già al limite di carica (${bounds.voltageMaxMv} mV)`;
		if (step?.type === 'discharge' && v <= bounds.voltageMinMv) return `tensione ${v} mV già al limite di scarica (${bounds.voltageMinMv} mV)`;
		// The bench drives the battery towards the voltage setpoint: it does not
		// charge above it nor discharge below it, and refuses to start otherwise
		if (step?.type === 'charge' && v >= step.voltageMv) return `tensione ${v} mV già al setpoint di carica ${step.voltageMv} mV o sopra: il banco non caricherebbe`;
		if (step?.type === 'discharge' && v <= step.voltageMv) return `tensione ${v} mV già al setpoint di scarica ${step.voltageMv} mV o sotto: il banco non scaricherebbe (in scarica voltageMv è la tensione finale, sotto quella attuale)`;
		return null;
	}

	start(spec, { requestedBy = 'agent', reason = null } = {}) {
		if (!this.config.enabled) return { ok: false, reason: 'procedure disattivate in config/supervisor.json' };
		if (this.current) return { ok: false, reason: `procedura ${this.current.id} già in corso: fermarla prima` };
		const { profile } = this.io.context();
		if (!profile?.usable) return { ok: false, reason: `nessun profilo batteria utilizzabile (${profile?.reasons?.join(', ') ?? 'profilo assente'})` };
		const check = validateProcedure(spec, { limits: profile.profile.limits, config: this.config });
		if (!check.ok) return check;
		const notReady = this.checkReady(check.steps[0]);
		if (notReady) return { ok: false, reason: notReady };

		const now = this.now();
		this.current = {
			id: procedureId(now),
			name: spec.name.trim(),
			spec,
			steps: check.steps,
			maxMinutes: check.maxMinutes,
			profile: profile.name,
			requestedBy,
			reason,
			startedAt: now,
			index: 0,
			stepStartedAt: null,
			results: []
		};
		this.stopRequest = null;
		const p = this.current;
		this.store.insert(p);
		this.state?.set('procedure.running', { id: p.id, name: p.name, startedAt: now });
		const text = `Procedura ${p.id} avviata (${requestedBy}): ${p.name} — ${p.steps.length} passi, al massimo ${Math.round(p.maxMinutes / 6) / 10} h, profilo ${p.profile}.${reason ? ` Motivo: ${reason}` : ''}`;
		this.io.event({ key: 'procedure:started', source: 'procedure', type: 'started', severity: 'info', silent: true, message: text, details: { id: p.id, spec } });
		this.io.notify(`▶️ ${text}\n${spec.steps.map((s, i) => `${i + 1}. ${describeStep(s)}`).join('\n')}${(spec.repeat ?? 1) > 1 ? `\n× ${spec.repeat}` : ''}`);
		this.log.log(`[PROCEDURE] ${text}`);
		this.done = this.execute();
		return { ok: true, id: p.id, steps: p.steps.length, maxMinutes: p.maxMinutes };
	}

	stop(reason) {
		if (!this.current) return { ok: false, reason: 'nessuna procedura in corso' };
		this.stopRequest ??= reason || 'fermata su richiesta';
		return { ok: true, id: this.current.id };
	}

	// A procedure left running by a previous process: nobody followed its end
	// conditions, so the battery is stopped and the procedure closed
	recover() {
		const saved = this.state?.get('procedure.running');
		if (!saved?.id) return;
		const message = 'interrotta dal riavvio del supervisore: batteria fermata';
		this.io.stop('procedure-restart');
		this.store.update({ id: saved.id, endedAt: this.now(), status: 'aborted', endMessage: message, results: null });
		this.state.set('procedure.running', null);
		this.io.event({ key: 'procedure:aborted', source: 'procedure', type: 'aborted', severity: 'warning', silent: true, message: `Procedura ${saved.id} (${saved.name}) ${message}`, details: saved });
		this.io.notify(`⚠️ Procedura ${saved.id} (${saved.name}) ${message}.`);
	}

	async execute() {
		const p = this.current;
		let status = 'completed';
		let message = `completata: ${p.steps.length} passi`;
		try {
			for (p.index = 0; p.index < p.steps.length; p.index++) {
				const step = p.steps[p.index];
				p.stepStartedAt = this.now();
				const result = step.type === 'rest' ? await this.runRest(step) : await this.runActive(step);
				p.results.push({ step: p.index + 1, type: step.type, startedAt: p.stepStartedAt, endedAt: this.now(), ...result });
				this.store.update(this.record(p, 'running'));
			}
		} catch (error) {
			status = error instanceof Abort ? error.status : 'aborted';
			message = `${status === 'stopped' ? 'fermata' : 'interrotta'} al passo ${p.index + 1}/${p.steps.length}: ${error.message}`;
			p.results.push({ step: p.index + 1, type: p.steps[p.index]?.type, startedAt: p.stepStartedAt, endedAt: this.now(), endedBy: status, message: error.message });
			this.io.stop('procedure');
		}

		const endedAt = this.now();
		this.store.update({ ...this.record(p, status), endedAt, endMessage: message });
		this.state?.set('procedure.running', null);
		const text = `Procedura ${p.id} (${p.name}) ${message}`;
		this.log.log(`[PROCEDURE] ${text}`);
		this.io.event({ key: `procedure:${status}`, source: 'procedure', type: status, severity: status === 'aborted' ? 'warning' : 'info', silent: true, message: text, details: { id: p.id, results: p.results } });
		this.io.notify(`${status === 'completed' ? '✅' : status === 'stopped' ? '⏹️' : '⚠️'} ${text}`);
		this.current = null;
		this.io.finished?.({ id: p.id, name: p.name, status, message, startedAt: p.startedAt, endedAt });
	}

	record(p, status) {
		return { id: p.id, status, results: p.results };
	}

	async tick() {
		await this.sleep(1000);
		if (this.stopRequest) throw new Abort(this.stopRequest, 'stopped');
	}

	async waitFor(predicate, failure) {
		const deadline = this.now() + (this.config.confirmTimeoutSeconds ?? 20) * 1000;
		while (!predicate()) {
			if (this.now() > deadline) throw new Abort(failure);
			await this.tick();
		}
	}

	async command(command, value) {
		if (this.stopRequest) throw new Abort(this.stopRequest, 'stopped');
		const result = await this.io.command(command, value);
		if (!result.ok) throw new Abort(`comando ${command}=${value} non riuscito: ${result.message}`);
	}

	async runRest(step) {
		const end = this.now() + step.minutes * 60000;
		while (this.now() < end) {
			await this.tick();
			const battery = this.io.battery();
			if (battery && battery.state.runState !== 0) throw new Abort('la batteria è partita durante il riposo (comando esterno?)');
		}
		const battery = this.io.battery();
		return { endedBy: 'minutes', vEndMv: battery?.state.voltageMeasuredMv ?? null };
	}

	async runActive(step) {
		const c = this.config;
		const mode = MODES[step.type];
		const label = LABELS[step.type];
		const notReady = this.checkReady(step);
		if (notReady) throw new Abort(`avvio della ${label} non possibile: ${notReady}`);
		const profileName = this.io.context().profile?.name;

		await this.command('set_current_ma', step.currentMa);
		await this.command('set_voltage_mv', step.voltageMv);
		await this.waitFor(() => {
			const s = this.io.battery()?.state;
			return s && Math.abs(s.currentSetpointMa) === step.currentMa && s.voltageSetpointMv === step.voltageMv;
		}, 'i setpoint non risultano applicati');
		await this.command('set_run_state', mode);
		await this.waitFor(() => this.io.battery()?.state.runState === mode, `la batteria non è passata in ${label}`);

		const started = this.now();
		const counts = {};
		let mah = 0;
		let lastAt = null;
		let lastCurrent = null;
		let endedBy = null;
		while (!endedBy) {
			await this.tick();
			const now = this.now();
			const battery = this.io.battery();
			const { profile, latched } = this.io.context();
			if (!battery || now - battery.at > (c.staleSeconds ?? 30) * 1000) throw new Abort('dati della batteria fermi');
			if (latched) throw new Abort('interblocco scattato');
			if (battery.state.runState !== mode) throw new Abort(`la batteria non è più in ${label} (interblocco, /stop o comando esterno)`);
			if (!profile?.usable || profile.name !== profileName) throw new Abort('profilo batteria cambiato o non più utilizzabile');
			if (battery.at === lastAt) continue;

			// Only new samples count, so a confirmation needs confirmSamples readings
			const s = battery.state;
			const current = Math.abs(s.currentMeasuredMa);
			if (lastAt !== null && (battery.at - lastAt) / 1000 <= 5) mah += ((lastCurrent + current) / 2) * ((battery.at - lastAt) / 1000) / 3600;
			lastAt = battery.at;
			lastCurrent = current;

			if (now - started >= (c.settleSeconds ?? 20) * 1000) {
				const until = step.until ?? {};
				const met = {
					voltageAboveMv: until.voltageAboveMv !== undefined && s.voltageMeasuredMv >= until.voltageAboveMv,
					voltageBelowMv: until.voltageBelowMv !== undefined && s.voltageMeasuredMv <= until.voltageBelowMv,
					currentBelowMa: until.currentBelowMa !== undefined && current <= until.currentBelowMa
				};
				for (const [key, ok] of Object.entries(met)) counts[key] = ok ? (counts[key] ?? 0) + 1 : 0;
				endedBy = Object.keys(met).find((key) => counts[key] >= (c.confirmSamples ?? 5)) ?? null;
			}
			if (!endedBy && step.until?.mAh !== undefined && mah >= step.until.mAh) endedBy = 'mAh';
			if (!endedBy && now - started >= step.maxMinutes * 60000) endedBy = 'maxMinutes';
		}

		const last = this.io.battery()?.state;
		await this.command('set_run_state', 0);
		await this.waitFor(() => this.io.battery()?.state.runState === 0, 'la batteria non si è fermata a fine passo');
		return {
			endedBy,
			minutes: Math.round((this.now() - started) / 6000) / 10,
			mAh: Math.round(mah),
			vEndMv: last?.voltageMeasuredMv ?? null,
			iEndMa: last ? Math.abs(last.currentMeasuredMa) : null
		};
	}
}

// Best-effort persistence: the procedure goes on with the database down
export class ProcedureStore {
	constructor(db, { log = console } = {}) {
		this.db = db;
		this.log = log;
		this.chain = Promise.resolve();
	}

	// In order: an update must not overtake the insert of the same procedure
	run(sql, params) {
		if (!this.db.ready) return;
		this.chain = this.chain
			.then(() => this.db.query(sql, params))
			.catch((error) => this.log.error('[ERROR] Procedure record failed:', error.message));
	}

	insert(p) {
		this.run(
			`INSERT INTO battery_procedures (procedure_id, started_at, name, status, requested_by, reason, profile, spec, steps)
			VALUES (?, ?, ?, 'running', ?, ?, ?, ?, '[]')`,
			[p.id, new Date(p.startedAt), p.name, p.requestedBy, p.reason?.slice(0, 300) ?? null, p.profile, JSON.stringify(p.spec)]
		);
	}

	update({ id, status, results, endedAt = null, endMessage = null }) {
		this.run(
			`UPDATE battery_procedures SET status = ?, steps = COALESCE(?, steps), ended_at = COALESCE(?, ended_at), end_message = COALESCE(?, end_message)
			WHERE procedure_id = ?`,
			[status, results ? JSON.stringify(results) : null, endedAt ? new Date(endedAt) : null, endMessage?.slice(0, 512) ?? null, id]
		);
	}
}
