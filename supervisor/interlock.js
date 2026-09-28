// Safety interlock: checks the MEASURED values against the active profile and
// stops the battery on its own, whatever the agent or the dashboards are doing.

// Pure check of one sample. Currents are compared in absolute value so the
// result does not depend on the sign convention of the controller.
export function checkLimits({ state, ntcTemperature, phaseSeconds }, limits) {
	const violations = [];
	const voltage = state.voltageMeasuredMv;
	const current = Math.abs(state.currentMeasuredMa);

	if (voltage > limits.vMax) {
		violations.push({ limit: 'vMax', value: voltage, threshold: limits.vMax, message: `tensione ${voltage} mV > vMax ${limits.vMax} mV` });
	}
	if (state.runState === 2 && voltage < limits.vMin) {
		violations.push({ limit: 'vMin', value: voltage, threshold: limits.vMin, message: `tensione ${voltage} mV < vMin ${limits.vMin} mV` });
	}
	if (state.runState === 1 && current > limits.iChargeMax) {
		violations.push({ limit: 'iChargeMax', value: current, threshold: limits.iChargeMax, message: `corrente di carica ${current} mA > ${limits.iChargeMax} mA` });
	}
	if (state.runState === 2 && current > limits.iDischargeMax) {
		violations.push({ limit: 'iDischargeMax', value: current, threshold: limits.iDischargeMax, message: `corrente di scarica ${current} mA > ${limits.iDischargeMax} mA` });
	}
	if (ntcTemperature !== null && ntcTemperature !== undefined && ntcTemperature > limits.tempMax) {
		violations.push({ limit: 'tempMax', value: ntcTemperature, threshold: limits.tempMax, message: `temperatura NTC ${ntcTemperature} °C > ${limits.tempMax} °C` });
	}
	if (phaseSeconds > limits.maxPhaseDuration) {
		violations.push({ limit: 'maxPhaseDuration', value: Math.round(phaseSeconds), threshold: limits.maxPhaseDuration, message: `fase attiva da ${Math.round(phaseSeconds)} s > ${limits.maxPhaseDuration} s` });
	}

	return violations;
}

export class Interlock {
	constructor(config, { sendStop, onLatchChange } = {}) {
		this.config = config;
		this.sendStop = sendStop ?? (() => {});
		this.onLatchChange = onLatchChange ?? (() => {});
		this.counts = new Map();
		this.phase = null;
		this.latched = null;
		this.stopRequest = null;
		this.events = [];
	}

	restoreLatch(latched) {
		this.latched = latched ?? null;
	}

	reset() {
		this.latched = null;
		this.onLatchChange(null);
	}

	// Called for every battery state received (1 Hz)
	onBatteryState(state, { profile, profileName, ntc } = {}, now) {
		const running = state.runState === 1 || state.runState === 2;

		if (this.phase?.runState !== state.runState) {
			// After a restart the real start of the phase is unknown: the duration
			// is counted from the first observation (it can only be underestimated).
			this.phase = { runState: state.runState, since: now };
		}

		this.followStopRequest(state, now);

		if (!running || !profile) {
			this.counts.clear();
			return;
		}

		let ntcTemperature = null;
		if (ntc && now - ntc.at <= this.config.temperatureStaleSeconds * 1000) {
			ntcTemperature = ntc.value;
		}

		const violations = checkLimits({ state, ntcTemperature, phaseSeconds: (now - this.phase.since) / 1000 }, profile.limits);
		if (ntcTemperature === null && this.config.stopOnMissingTemperature) {
			violations.push({ limit: 'tempMax', value: null, threshold: profile.limits.tempMax, message: 'temperatura NTC non disponibile' });
		}

		const seen = new Set(violations.map((v) => v.limit));
		for (const limit of this.counts.keys()) {
			if (!seen.has(limit)) this.counts.delete(limit);
		}
		for (const violation of violations) {
			this.counts.set(violation.limit, (this.counts.get(violation.limit) ?? 0) + 1);
		}

		const confirmed = violations.filter((v) => this.counts.get(v.limit) >= this.config.confirmSamples);
		const stopPending = this.stopRequest && !this.stopRequest.confirmedAt;
		if (confirmed.length > 0 && !stopPending) {
			this.trip(confirmed, state, profileName, now);
		}
	}

	trip(violations, state, profileName, now) {
		this.latched = { at: new Date(now).toISOString(), profile: profileName, reasons: violations.map((v) => v.message) };
		this.onLatchChange(this.latched);
		this.stopRequest = { at: now, lastAt: now, attempts: 1, confirmedAt: null, failed: false };
		this.counts.clear();
		this.sendStop('interlock');

		this.events.push({
			key: 'interlock:trip',
			source: 'interlock',
			type: 'trip',
			severity: 'critical',
			message: `INTERBLOCCO: stop inviato alla batteria. Motivo: ${this.latched.reasons.join('; ')}`,
			details: { violations, state, profile: profileName }
		});
	}

	followStopRequest(state, now) {
		const request = this.stopRequest;
		if (!request || request.confirmedAt) return;

		if (state.runState === 0) {
			request.confirmedAt = now;
			this.events.push({
				key: 'interlock:stopped',
				source: 'interlock',
				type: 'stopped',
				severity: 'warning',
				message: `Stop confermato: batteria ferma dopo ${Math.round((now - request.at) / 1000)} s`,
				details: { attempts: request.attempts }
			});
			return;
		}

		if (now - request.lastAt >= this.config.stopVerifySeconds * 1000) {
			if (request.attempts < this.config.stopRetries) {
				request.attempts++;
				request.lastAt = now;
				this.sendStop('interlock-retry');
			} else {
				request.failed = true;
			}
		}
	}

	drainEvents() {
		const events = this.events;
		this.events = [];
		return events;
	}

	conditions() {
		const conditions = [];
		if (this.stopRequest?.failed && !this.stopRequest.confirmedAt) {
			conditions.push({
				key: 'interlock:stop_failed',
				source: 'interlock',
				type: 'stop_failed',
				severity: 'critical',
				message: `Lo stop dell'interblocco NON ha effetto dopo ${this.stopRequest.attempts} tentativi: intervenire manualmente`,
				details: { attempts: this.stopRequest.attempts }
			});
		}
		if (this.latched) {
			conditions.push({
				key: 'interlock:latched',
				source: 'interlock',
				type: 'latched',
				severity: 'info',
				message: `Interblocco scattato (${this.latched.reasons.join('; ')}). Dopo le verifiche usare /reset`,
				details: this.latched
			});
		}
		return conditions;
	}
}
