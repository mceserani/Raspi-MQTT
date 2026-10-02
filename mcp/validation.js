// Safety checks for the battery commands of the agent (docs/PIANO-AGENTE.md, 5.2).
// Pure functions: the source of truth is the status published by the supervisor
// (active profile, limits, interlock latch, live values). Anything missing or
// stale means "no": only the stop is always allowed.

export const AGENT_COMMANDS = ['set_current_ma', 'set_voltage_mv', 'set_run_state'];

// Working bounds for the setpoints: stricter than the interlock thresholds by
// the configured margins, so an accepted command cannot trip the interlock by itself.
export function commandBounds(limits, margins) {
	const scale = 1 - margins.currentMarginPct / 100;
	return {
		voltageMinMv: limits.vMin + margins.voltageMarginMv,
		voltageMaxMv: limits.vMax - margins.voltageMarginMv,
		chargeCurrentMaxMa: Math.floor(limits.iChargeMax * scale),
		dischargeCurrentMaxMa: Math.floor(limits.iDischargeMax * scale),
		temperatureMaxC: limits.tempMax - margins.temperatureMarginC
	};
}

function currentLimitFor(runState, bounds) {
	if (runState === 1) return bounds.chargeCurrentMaxMa;
	if (runState === 2) return bounds.dischargeCurrentMaxMa;
	// Stopped: the start command checks the setpoint against the chosen mode
	return Math.max(bounds.chargeCurrentMaxMa, bounds.dischargeCurrentMaxMa);
}

// Age in seconds of the status and of the values inside it. A retained status
// arrives at once even if old: its own timestamp is what counts.
export function statusAgeSeconds(status, now) {
	const at = Date.parse(status?.at);
	return Number.isNaN(at) ? Infinity : Math.max(0, (now - at) / 1000);
}

// status: payload of supervisor/status. Returns { ok: true, bounds } or { ok: false, reason }.
export function validateBatteryCommand({ command, value }, { status, now, config }) {
	const refuse = (reason) => ({ ok: false, reason });

	if (!AGENT_COMMANDS.includes(command)) {
		return refuse(`comando non consentito: ${command}`);
	}
	if (!Number.isInteger(value) || value < 0 || value > 32767) {
		return refuse('il valore deve essere un intero tra 0 e 32767');
	}
	if (command === 'set_run_state' && ![0, 1, 2].includes(value)) {
		return refuse('set_run_state accetta solo 0 (stop), 1 (carica), 2 (scarica)');
	}

	// The stop needs nothing else: it must work even with a stale status or no profile
	if (command === 'set_run_state' && value === 0) {
		return { ok: true, bounds: null };
	}

	if (!status || status.online === false) {
		return refuse('supervisore non raggiungibile: consentito solo lo stop');
	}
	const statusAge = statusAgeSeconds(status, now);
	if (statusAge > config.status.maxAgeSeconds) {
		return refuse(`stato del supervisore vecchio di ${Math.round(statusAge)} s: consentito solo lo stop`);
	}
	if (status.interlock?.latched) {
		return refuse(`interblocco scattato (${status.interlock.latched.reasons?.join('; ') ?? 'motivo sconosciuto'}): serve /reset dall'utente, consentito solo lo stop`);
	}
	if (status.procedure?.running) {
		return refuse(`procedura ${status.procedure.id} in corso: i comandi li dà il supervisore; consentito solo lo stop (o stop_procedure)`);
	}
	if (!status.profile?.usable || !status.profile.limits) {
		return refuse(`nessun profilo batteria utilizzabile (${status.profile?.reasons?.join(', ') ?? 'profilo assente'}): l'agente può solo osservare`);
	}

	const battery = status.live?.battery;
	if (!battery) {
		return refuse('nessun dato dalla batteria');
	}
	const batteryAge = battery.ageSeconds + statusAge;
	if (batteryAge > config.commands.batteryMaxAgeSeconds) {
		return refuse(`dati della batteria vecchi di ${Math.round(batteryAge)} s`);
	}

	const bounds = commandBounds(status.profile.limits, config.commands);
	const runState = battery.runState;
	const currentSetpoint = Math.abs(battery.currentSetpointMa);
	const voltageSetpoint = battery.voltageSetpointMv;

	if (command === 'set_voltage_mv') {
		if (value < bounds.voltageMinMv || value > bounds.voltageMaxMv) {
			return refuse(`tensione ${value} mV fuori dall'intervallo consentito ${bounds.voltageMinMv}–${bounds.voltageMaxMv} mV`);
		}
		return { ok: true, bounds };
	}

	if (command === 'set_current_ma') {
		const max = currentLimitFor(runState, bounds);
		if (value > max) {
			return refuse(`corrente ${value} mA oltre il massimo consentito ${max} mA${runState === 0 ? '' : ` nello stato attuale (${runState === 1 ? 'carica' : 'scarica'})`}`);
		}
		return { ok: true, bounds };
	}

	// set_run_state 1 or 2: start charge or discharge
	if (runState === value) {
		return refuse(`la batteria è già in ${value === 1 ? 'carica' : 'scarica'}`);
	}
	if (runState !== 0) {
		return refuse('per cambiare modo fermare prima la batteria (set_run_state 0)');
	}

	const mode = value === 1 ? 'carica' : 'scarica';
	const maxCurrent = currentLimitFor(value, bounds);
	if (currentSetpoint > maxCurrent) {
		return refuse(`setpoint di corrente ${currentSetpoint} mA oltre il massimo per la ${mode} (${maxCurrent} mA): impostarlo prima`);
	}
	if (voltageSetpoint < bounds.voltageMinMv || voltageSetpoint > bounds.voltageMaxMv) {
		return refuse(`setpoint di tensione ${voltageSetpoint} mV fuori dall'intervallo ${bounds.voltageMinMv}–${bounds.voltageMaxMv} mV: impostarlo prima`);
	}
	if (value === 1 && battery.voltageMeasuredMv >= bounds.voltageMaxMv) {
		return refuse(`tensione misurata ${battery.voltageMeasuredMv} mV già al limite di carica (${bounds.voltageMaxMv} mV)`);
	}
	if (value === 2 && battery.voltageMeasuredMv <= bounds.voltageMinMv) {
		return refuse(`tensione misurata ${battery.voltageMeasuredMv} mV già al limite di scarica (${bounds.voltageMinMv} mV)`);
	}

	const ntc = status.live?.lab?.ntc_temperature;
	if (!ntc || ntc.invalid || ntc.ageSeconds + statusAge > config.commands.temperatureMaxAgeSeconds) {
		return refuse('temperatura NTC non disponibile: avvio non consentito');
	}
	if (ntc.value > bounds.temperatureMaxC) {
		return refuse(`temperatura NTC ${ntc.value} °C sopra il massimo per l'avvio (${bounds.temperatureMaxC} °C)`);
	}

	return { ok: true, bounds };
}
