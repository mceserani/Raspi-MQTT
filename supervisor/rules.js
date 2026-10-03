import { windowMean } from './stats.js';

export const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 };

export const SENSOR_INFO = {
	temperature: { label: 'Temperatura', unit: '°C' },
	humidity: { label: 'Umidità', unit: '%' },
	pm2_5: { label: 'PM2.5', unit: 'µg/m³' },
	pm10: { label: 'PM10', unit: 'µg/m³' },
	voc: { label: 'VOC', unit: 'indice' },
	nox: { label: 'NOx', unit: 'indice' },
	co2: { label: 'CO2', unit: 'ppm' },
	ntc_temperature: { label: 'Temperatura NTC', unit: '°C' }
};

export const RUN_STATE_LABELS = { 0: 'ferma', 1: 'carica', 2: 'scarica' };

function round(value, digits = 1) {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

// Steps of one threshold direction, from the least to the most severe. Each
// severity is a number or a list (several steps of the same severity, e.g.
// CO2 warning at 1500 and again at 2000 ppm).
const STEP_SEVERITIES = ['info', 'warning', 'critical'];
function thresholdSteps(limits, direction) {
	const steps = STEP_SEVERITIES.flatMap((severity) => [].concat(limits[severity] ?? []).map((limit) => ({ severity, limit })));
	return steps.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (direction === 'high' ? a.limit - b.limit : b.limit - a.limit));
}

function isRunStateCommand(ack) {
	return ack.command === 'set_run_state' || (ack.command === 'write_register' && Number(ack.register) === 404);
}

// Continuous rules on the MQTT data. evaluate() returns the conditions active
// right now (the event manager turns them into open/resolved events) plus
// one-shot events that happened since the previous call.
export class RuleEngine {
	constructor(config, { profileProvider } = {}) {
		this.config = config;
		this.profileProvider = profileProvider ?? (() => null);
		this.startedAt = null;
		this.lab = new Map();
		this.battery = null;
		this.batteryChangedAt = null;
		this.runStateChange = null;
		this.acks = [];
		this.pending = new Map();
		this.active = new Map();
		this.oneShots = [];
		this.healthConditions = [];
	}

	onLab(sensor, value, now) {
		const cfg = this.config.lab.sensors[sensor] ?? {};
		const entry = this.lab.get(sensor) ?? { history: [] };
		entry.value = value;
		entry.at = now;
		entry.invalid = typeof value !== 'number' || !Number.isFinite(value)
			|| (cfg.valid && (value < cfg.valid[0] || value > cfg.valid[1]));

		if (!entry.invalid) {
			entry.history.push({ t: now, v: value });
			const keepMs = (Math.max(cfg.window ?? 0, cfg.rate?.per ?? 0) + 5) * 1000;
			while (entry.history.length > 0 && entry.history[0].t < now - keepMs) {
				entry.history.shift();
			}
		}

		this.lab.set(sensor, entry);
	}

	onBattery(state, now) {
		const previous = this.battery?.state;
		if (!previous) {
			this.batteryChangedAt = now;
		} else {
			if (previous.runState !== state.runState) {
				this.runStateChange = { from: previous.runState, to: state.runState, at: now };
			}
			if (previous.runState !== state.runState
				|| previous.currentSetpointMa !== state.currentSetpointMa
				|| previous.voltageSetpointMv !== state.voltageSetpointMv) {
				this.batteryChangedAt = now;
			}
		}

		this.battery = { state, at: now };
	}

	onAck(ack, now) {
		this.acks.push({ at: now, ack });
		const windowMs = this.config.battery.commandAckWindowSeconds * 1000;
		this.acks = this.acks.filter((item) => item.at >= now - 2 * windowMs);

		if (ack.status === 'error') {
			this.oneShots.push({
				key: 'battery:command_error',
				source: 'battery',
				type: 'command_error',
				severity: 'warning',
				message: `Comando batteria ${ack.command ?? '?'} rifiutato: ${ack.message ?? 'errore'}`,
				details: ack
			});
		}
	}

	setHealth(conditions) {
		this.healthConditions = conditions;
	}

	labValue(sensor) {
		const entry = this.lab.get(sensor);
		return entry && !entry.invalid ? { value: entry.value, at: entry.at } : null;
	}

	evaluate(now) {
		this.startedAt ??= now;
		const candidates = [];

		this.labRules(now, candidates);
		this.batteryRules(now, candidates);
		candidates.push(...this.healthConditions);

		// Sustain: a new condition becomes active only after it held long enough;
		// an active one follows the candidate immediately (escalation included).
		const active = new Map();
		for (const candidate of candidates) {
			const { sustain = 0, ...condition } = candidate;
			if (this.active.has(condition.key)) {
				active.set(condition.key, condition);
				continue;
			}

			const since = this.pending.get(condition.key) ?? now;
			if (now - since >= sustain * 1000) {
				active.set(condition.key, condition);
				this.pending.delete(condition.key);
			} else {
				this.pending.set(condition.key, since);
			}
		}

		const candidateKeys = new Set(candidates.map((c) => c.key));
		for (const key of this.pending.keys()) {
			if (!candidateKeys.has(key)) this.pending.delete(key);
		}

		this.active = active;
		const events = this.oneShots;
		this.oneShots = [];
		return { conditions: [...active.values()], events };
	}

	labRules(now, out) {
		const staleSensors = [];

		for (const [sensor, cfg] of Object.entries(this.config.lab.sensors)) {
			const info = SENSOR_INFO[sensor] ?? { label: sensor, unit: '' };
			const entry = this.lab.get(sensor);
			const lastAt = entry?.at ?? this.startedAt;

			if (now - lastAt > this.config.lab.staleSeconds * 1000) {
				staleSensors.push(sensor);
				continue;
			}
			if (!entry) continue;

			if (entry.invalid) {
				out.push({
					key: `lab:invalid:${sensor}`,
					source: 'lab',
					type: 'invalid',
					severity: 'warning',
					message: `${info.label}: lettura non plausibile (${entry.value})`,
					details: { sensor, value: entry.value, valid: cfg.valid }
				});
			}

			const value = cfg.window
				? windowMean(entry.history, now, cfg.window * 1000)
				: entry.history.at(-1)?.v ?? null;
			if (value !== null) {
				for (const direction of ['high', 'low']) {
					const condition = this.thresholdCondition(sensor, cfg, direction, value, info);
					if (condition) out.push(condition);
				}
			}

			if (cfg.rate && entry.history.length > 1) {
				const recent = entry.history.filter((sample) => sample.t >= now - cfg.rate.per * 1000).map((sample) => sample.v);
				const delta = Math.max(...recent) - Math.min(...recent);
				if (delta > cfg.rate.maxDelta) {
					out.push({
						key: `lab:rate:${sensor}`,
						source: 'lab',
						type: 'rate_of_change',
						severity: 'warning',
						message: `${info.label}: variazione rapida di ${round(delta)} ${info.unit} in ${cfg.rate.per} s`,
						details: { sensor, delta: round(delta, 2), maxDelta: cfg.rate.maxDelta, per: cfg.rate.per }
					});
				}
			}
		}

		if (staleSensors.length > 0) {
			const all = staleSensors.length === Object.keys(this.config.lab.sensors).length;
			out.push({
				key: 'lab:stale',
				source: 'lab',
				type: 'stale',
				severity: 'warning',
				message: all
					? `Nessun dato dai sensori di laboratorio da oltre ${this.config.lab.staleSeconds} s`
					: `Dati fermi da oltre ${this.config.lab.staleSeconds} s: ${staleSensors.join(', ')}`,
				details: { sensors: staleSensors }
			});
		}
	}

	thresholdCondition(sensor, cfg, direction, value, info) {
		const limits = cfg[direction];
		if (!limits) return null;

		const key = `lab:threshold:${sensor}:${direction}`;
		const currentStep = this.active.get(key)?.step ?? -1;
		const hysteresis = cfg.hysteresis ?? 0;
		const beyond = (limit, margin) => (direction === 'high' ? value >= limit - margin : value <= limit + margin);

		// The most severe step crossed; the hysteresis keeps the steps already reached
		const steps = thresholdSteps(limits, direction);
		const step = steps.findLastIndex((s, index) => beyond(s.limit, index <= currentStep ? hysteresis : 0));
		if (step < 0) return null;
		const { severity, limit } = steps.at(step);

		return {
			key,
			source: 'lab',
			type: 'threshold',
			severity,
			step,
			sustain: cfg.sustain ?? 0,
			message: `${info.label} ${direction === 'high' ? 'alta' : 'bassa'}: ${round(value)} ${info.unit} (soglia ${limit})`,
			details: { sensor, direction, value: round(value, 2), limit, windowSeconds: cfg.window ?? null }
		};
	}

	batteryRules(now, out) {
		const cfg = this.config.battery;
		const staleMs = cfg.staleSeconds * 1000;

		if (!this.battery) {
			if (now - this.startedAt > staleMs) {
				out.push({ key: 'battery:stale', source: 'battery', type: 'stale', severity: 'warning', message: 'Nessun dato dalla batteria', details: {} });
			}
			return;
		}

		const { state, at } = this.battery;
		if (now - at > staleMs) {
			const running = state.runState === 1 || state.runState === 2;
			out.push({
				key: 'battery:stale',
				source: 'battery',
				type: 'stale',
				severity: running ? 'critical' : 'warning',
				message: `Nessun dato dalla batteria da ${Math.round((now - at) / 1000)} s${running ? ` (ultimo stato: ${RUN_STATE_LABELS[state.runState]})` : ''}`,
				details: { lastState: state }
			});
			return;
		}

		if (![0, 1, 2].includes(state.runState)) {
			out.push({ key: 'battery:run_state_unknown', source: 'battery', type: 'run_state_unknown', severity: 'warning', message: `Stato batteria sconosciuto: ${state.runState}`, details: { runState: state.runState } });
		}

		const running = state.runState === 1 || state.runState === 2;
		if (running && !this.profileProvider()?.usable) {
			out.push({
				key: 'battery:no_profile',
				source: 'battery',
				type: 'no_profile',
				severity: 'warning',
				message: 'Batteria in funzione senza un profilo di sicurezza utilizzabile: interblocco inattivo',
				details: { batteryType: state.batteryType }
			});
		}

		if (running && now - this.batteryChangedAt >= cfg.settleSeconds * 1000) {
			this.trackingRules(state, out);
		}

		if (this.runStateChange) {
			const change = this.runStateChange;
			const windowMs = cfg.commandAckWindowSeconds * 1000;
			const commanded = this.acks.some((item) => item.ack.status === 'ok' && isRunStateCommand(item.ack) && Math.abs(item.at - change.at) <= windowMs);
			if (commanded) {
				this.runStateChange = null;
			} else if (now - change.at > windowMs) {
				this.oneShots.push({
					key: 'battery:uncommanded_run_state',
					source: 'battery',
					type: 'uncommanded_run_state',
					severity: 'warning',
					message: `Stato batteria cambiato senza comando: ${RUN_STATE_LABELS[change.from] ?? change.from} → ${RUN_STATE_LABELS[change.to] ?? change.to}`,
					details: change
				});
				this.runStateChange = null;
			}
		}
	}

	trackingRules(state, out) {
		const cfg = this.config.battery;
		const current = Math.abs(state.currentMeasuredMa);
		const setpoint = Math.abs(state.currentSetpointMa);
		const tolerance = (setpoint * cfg.currentTolerancePct) / 100 + cfg.currentToleranceMa;
		const voltage = state.voltageMeasuredMv;
		let deviation = null;

		if (state.runState === 1) {
			if (current > setpoint + tolerance) {
				deviation = 'sopra';
			} else if (current < setpoint - tolerance && voltage < state.voltageSetpointMv - cfg.cvBandMv) {
				// Below the setpoint is normal only in the CV phase (voltage at the setpoint)
				deviation = 'sotto';
			}

			if (voltage > state.voltageSetpointMv + cfg.voltageToleranceMv) {
				out.push({
					key: 'battery:voltage_over_setpoint',
					source: 'battery',
					type: 'voltage_over_setpoint',
					severity: 'warning',
					sustain: cfg.sustain,
					message: `Tensione in carica sopra il setpoint: ${voltage} mV (setpoint ${state.voltageSetpointMv} mV)`,
					details: { voltageMv: voltage, setpointMv: state.voltageSetpointMv }
				});
			}
		} else if (current > setpoint + tolerance) {
			deviation = 'sopra';
		} else if (current < setpoint - tolerance && voltage > state.voltageSetpointMv + cfg.cvBandMv) {
			// Discharge: the bench also tapers the current once the voltage
			// reaches the setpoint (on the Pi it settles about 25 mV above it)
			deviation = 'sotto';
		}

		if (deviation) {
			out.push({
				key: 'battery:current_deviation',
				source: 'battery',
				type: 'current_deviation',
				severity: 'warning',
				sustain: cfg.sustain,
				message: `Corrente ${deviation} il setpoint in ${RUN_STATE_LABELS[state.runState]}: ${current} mA (setpoint ${setpoint} mA)`,
				details: { currentMa: state.currentMeasuredMa, setpointMa: state.currentSetpointMa, voltageMv: voltage }
			});
		}
	}

	snapshot(now) {
		const lab = {};
		for (const [sensor, entry] of this.lab) {
			lab[sensor] = { value: entry.value, ageSeconds: Math.round((now - entry.at) / 1000), invalid: entry.invalid };
		}

		return {
			lab,
			battery: this.battery ? { ...this.battery.state, ageSeconds: Math.round((now - this.battery.at) / 1000) } : null
		};
	}
}
