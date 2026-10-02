// Battery phases (docs/PIANO-AGENTE.md, 5.4): every charge or discharge, found
// from the run_state changes in the raw battery table, with capacity, energy,
// CC/CV time and internal resistance computed here. The MCP tool
// get_battery_cycles pairs them into cycles; the agent only interprets.
//
// The current is integrated with its sign and the magnitude is stored: no
// assumption on the sign convention, which is recorded per phase (currentSign).

const HOUR_MS = 3600000;
const RUN_STATES = { 1: 'carica', 2: 'scarica' };

export const PHASES_TABLE = `CREATE TABLE IF NOT EXISTS battery_phases (
	id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
	started_at DATETIME(3) NOT NULL,
	ended_at DATETIME(3) NOT NULL,
	run_state TINYINT NOT NULL,
	battery_type INT NULL,
	end_reason VARCHAR(16) NOT NULL,
	next_state TINYINT NULL,
	duration_s DOUBLE NOT NULL,
	samples INT NOT NULL,
	gap_s DOUBLE NOT NULL,
	charge_mah DOUBLE NOT NULL,
	energy_wh DOUBLE NOT NULL,
	current_sign TINYINT NOT NULL,
	v_start_mv INT NULL,
	v_end_mv INT NULL,
	v_min_mv INT NULL,
	v_max_mv INT NULL,
	i_avg_ma DOUBLE NULL,
	i_max_ma INT NULL,
	i_set_ma INT NULL,
	v_set_mv INT NULL,
	cc_s DOUBLE NOT NULL,
	cv_s DOUBLE NOT NULL,
	r_start_mohm DOUBLE NULL,
	r_end_mohm DOUBLE NULL,
	PRIMARY KEY (id),
	UNIQUE KEY uq_started_at (started_at)
)`;

const num = (value) => (value === null || value === undefined || value === '' ? null : Number(value));

export function normalizeRow(row) {
	return {
		t: new Date(row.recorded_at).getTime(),
		state: num(row.run_state),
		type: num(row.battery_type),
		v: num(row.voltage_measured_mv),
		i: num(row.current_measured_ma),
		iSet: num(row.current_setpoint_ma),
		vSet: num(row.voltage_setpoint_mv)
	};
}

// mV / mA = ohm -> mOhm
function resistance(vLoaded, vRest, current) {
	if (vLoaded === null || vRest === null || !current) return null;
	return Math.round((Math.abs(vLoaded - vRest) / Math.abs(current)) * 1000 * 10) / 10;
}

// Streaming detector: push() the rows in time order, it returns the phases
// that have ended. Its state is plain JSON, saved between runs.
export class PhaseTracker {
	constructor(config, saved = null) {
		this.config = {
			minPhaseSeconds: 30,
			maxIntegrateGapSeconds: 5,
			splitGapSeconds: 600,
			ccTolerancePct: 5,
			cvToleranceMv: 20,
			restWindowSeconds: 10,
			...config
		};
		this.open = saved?.open ?? null;
		this.last = saved?.last ?? null;
	}

	toJSON() {
		return { open: this.open, last: this.last };
	}

	push(row) {
		const closed = [];
		const c = this.config;
		const o = this.open;
		if (o) {
			if (row.t - o.lastT > c.splitGapSeconds * 1000) {
				closed.push(this.close('data_gap', null, null));
			} else if (row.state !== o.state) {
				closed.push(this.close('state_change', row.state, row));
			} else {
				this.accumulate(row);
			}
		}
		if (!this.open && (row.state === 1 || row.state === 2)) {
			this.start(row);
		}
		this.last = { t: row.t, state: row.state, v: row.v };
		return closed.filter((phase) => phase.durationS >= c.minPhaseSeconds);
	}

	// No rows for longer than splitGapSeconds (service stopped): the phase ends
	flush(nowMs) {
		if (!this.open || nowMs - this.open.lastT <= this.config.splitGapSeconds * 1000) return [];
		return [this.close('data_gap', null, null)].filter((phase) => phase.durationS >= this.config.minPhaseSeconds);
	}

	start(row) {
		const prev = this.last;
		const restBefore = prev && prev.state === 0 && prev.v !== null && row.t - prev.t <= this.config.restWindowSeconds * 1000;
		this.open = {
			state: row.state,
			type: row.type,
			startT: row.t,
			lastT: row.t,
			samples: 1,
			gapS: 0,
			q: 0,
			e: 0,
			last: row.v !== null && row.i !== null ? { v: row.v, i: row.i } : null,
			vStart: row.v,
			vEnd: row.v,
			vMin: row.v,
			vMax: row.v,
			sumAbsI: row.i === null ? 0 : Math.abs(row.i),
			nI: row.i === null ? 0 : 1,
			iMax: row.i === null ? null : Math.abs(row.i),
			iSet: row.iSet === null ? null : Math.abs(row.iSet),
			vSet: row.vSet,
			ccS: 0,
			cvS: 0,
			vRest: restBefore ? prev.v : null,
			rStart: null,
			lastLoaded: null
		};
		this.checkStartResistance(row);
		this.markLoaded(row);
	}

	// First sample with the current established (80 % of the setpoint) within
	// restWindowSeconds of the start: step from the rest voltage before it
	checkStartResistance(row) {
		const o = this.open;
		if (o.vRest === null || o.rStart !== null) return;
		if (row.t - o.startT > this.config.restWindowSeconds * 1000) {
			o.vRest = null;
			return;
		}
		if (row.v !== null && row.i !== null && o.iSet && Math.abs(row.i) >= 0.8 * o.iSet) {
			o.rStart = resistance(row.v, o.vRest, row.i);
			o.vRest = null;
		}
	}

	markLoaded(row) {
		if (row.v !== null && row.i !== null && Math.abs(row.i) > 0) {
			this.open.lastLoaded = { t: row.t, v: row.v, i: row.i };
		}
	}

	accumulate(row) {
		const o = this.open;
		const c = this.config;
		const dt = (row.t - o.lastT) / 1000;
		o.samples += 1;
		o.lastT = row.t;

		if (row.v === null || row.i === null) {
			o.gapS += dt;
			return;
		}
		if (o.last && dt <= c.maxIntegrateGapSeconds) {
			o.q += ((o.last.i + row.i) / 2) * dt;
			o.e += ((o.last.v * o.last.i + row.v * row.i) / 2) * dt;
			const iSet = row.iSet === null ? 0 : Math.abs(row.iSet);
			if (iSet > 0 && Math.abs(row.i) >= iSet * (1 - c.ccTolerancePct / 100)) {
				o.ccS += dt;
			} else if (row.vSet !== null && Math.abs(row.v - row.vSet) <= c.cvToleranceMv) {
				o.cvS += dt;
			}
		} else {
			o.gapS += dt;
		}
		o.last = { v: row.v, i: row.i };
		o.vEnd = row.v;
		o.vMin = o.vMin === null ? row.v : Math.min(o.vMin, row.v);
		o.vMax = o.vMax === null ? row.v : Math.max(o.vMax, row.v);
		o.sumAbsI += Math.abs(row.i);
		o.nI += 1;
		o.iMax = Math.max(o.iMax ?? 0, Math.abs(row.i));
		this.checkStartResistance(row);
		this.markLoaded(row);
	}

	close(endReason, nextState, after) {
		const o = this.open;
		this.open = null;
		const loaded = o.lastLoaded;
		const restAfter = after && after.state === 0 && after.v !== null && loaded && after.t - loaded.t <= this.config.restWindowSeconds * 1000;
		return {
			startedAt: o.startT,
			endedAt: o.lastT,
			runState: o.state,
			batteryType: o.type,
			endReason,
			nextState,
			durationS: (o.lastT - o.startT) / 1000,
			samples: o.samples,
			gapS: Math.round(o.gapS),
			// mA·s -> mAh; mV·mA·s = µJ -> Wh
			chargeMah: Math.abs(o.q) / 3600,
			energyWh: Math.abs(o.e) / 3.6e9,
			currentSign: Math.sign(o.q),
			vStartMv: o.vStart,
			vEndMv: o.vEnd,
			vMinMv: o.vMin,
			vMaxMv: o.vMax,
			iAvgMa: o.nI ? o.sumAbsI / o.nI : null,
			iMaxMa: o.iMax,
			iSetMa: o.iSet,
			vSetMv: o.vSet,
			ccS: o.ccS,
			cvS: o.cvS,
			rStartMohm: o.rStart,
			rEndMohm: restAfter ? resistance(loaded.v, after.v, loaded.i) : null
		};
	}

	// Phase still running, for the status and the MCP tool
	inProgress() {
		const o = this.open;
		if (!o) return null;
		return {
			state: RUN_STATES[o.state],
			since: o.startT,
			minutes: Math.round((o.lastT - o.startT) / 60000),
			chargeMah: Math.round(Math.abs(o.q) / 3600),
			energyWh: Math.round((Math.abs(o.e) / 3.6e9) * 100) / 100,
			currentSign: Math.sign(o.q)
		};
	}
}

function formatDuration(seconds) {
	const minutes = Math.round(seconds / 60);
	return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

const volts = (mv) => (mv === null ? '?' : (mv / 1000).toFixed(2).replace('.', ','));

export function describePhase(phase) {
	const what = phase.runState === 1 ? 'Carica' : 'Scarica';
	const sign = phase.currentSign > 0 ? 'positiva' : phase.currentSign < 0 ? 'negativa' : 'nulla';
	const ended = phase.endReason === 'data_gap' ? ', interrotta da un buco nei dati' : '';
	return `${what} conclusa${ended}: ${formatDuration(phase.durationS)}, ${Math.round(phase.chargeMah)} mAh, ${phase.energyWh.toFixed(2).replace('.', ',')} Wh, ${volts(phase.vStartMv)} → ${volts(phase.vEndMv)} V (corrente misurata ${sign})`;
}

// Runs in the supervisor: reads the raw rows from a cursor, one hour at a time,
// and writes the ended phases into battery_phases (idempotent on started_at).
export class CycleDetector {
	constructor({ db, state, config, table, onPhase = () => {}, log = console, now = () => Date.now() }) {
		if (!/^\w+$/.test(table)) throw new Error(`Invalid table name: ${table}`);
		this.db = db;
		this.state = state;
		this.config = config ?? { enabled: false };
		this.table = table;
		this.onPhase = onPhase;
		this.log = log;
		this.now = now;
		this.running = false;
		this.tracker = null;
		this.maxChunksPerRun = 24;
	}

	inProgress() {
		return this.tracker?.inProgress() ?? null;
	}

	async run() {
		if (!this.config.enabled || this.running || !this.db.ready) return;
		this.running = true;
		try {
			const saved = this.state.get('cycles');
			this.tracker ??= new PhaseTracker(this.config, saved);
			let cursor = saved?.cursor ?? null;
			if (cursor === null) {
				const [first] = await this.db.query(`SELECT MIN(recorded_at) AS t FROM ${this.table}`);
				if (!first?.t) return;
				cursor = new Date(first.t).getTime();
			}

			const end = this.now() - (this.config.lagSeconds ?? 15) * 1000;
			for (let chunk = 0; chunk < this.maxChunksPerRun && cursor < end; chunk++) {
				const chunkEnd = Math.min(cursor + HOUR_MS, end);
				const rows = await this.db.query(
					`SELECT recorded_at, run_state, battery_type, voltage_measured_mv, current_measured_ma, current_setpoint_ma, voltage_setpoint_mv
					FROM ${this.table} WHERE recorded_at >= ? AND recorded_at < ? ORDER BY recorded_at`,
					[new Date(cursor), new Date(chunkEnd)]
				);
				const phases = [];
				for (const row of rows) phases.push(...this.tracker.push(normalizeRow(row)));

				let next = chunkEnd;
				if (rows.length === 0) {
					// Skip long stretches without data in one step
					const [following] = await this.db.query(`SELECT MIN(recorded_at) AS t FROM ${this.table} WHERE recorded_at >= ?`, [new Date(chunkEnd)]);
					next = following?.t ? Math.min(Math.max(new Date(following.t).getTime(), chunkEnd), end) : end;
				}
				phases.push(...this.tracker.flush(next));

				for (const phase of phases) await this.save(phase);
				cursor = next;
				await this.state.set('cycles', { cursor, ...this.tracker.toJSON() });
				for (const phase of phases) this.onPhase(phase);
			}
		} catch (error) {
			// The tracker is rebuilt from the last saved state
			this.tracker = null;
			this.log.error('[ERROR] Battery phases failed:', error.message);
		} finally {
			this.running = false;
		}
	}

	async save(p) {
		const columns = {
			started_at: new Date(p.startedAt), ended_at: new Date(p.endedAt), run_state: p.runState, battery_type: p.batteryType,
			end_reason: p.endReason, next_state: p.nextState, duration_s: p.durationS, samples: p.samples, gap_s: p.gapS,
			charge_mah: p.chargeMah, energy_wh: p.energyWh, current_sign: p.currentSign,
			v_start_mv: p.vStartMv, v_end_mv: p.vEndMv, v_min_mv: p.vMinMv, v_max_mv: p.vMaxMv,
			i_avg_ma: p.iAvgMa, i_max_ma: p.iMaxMa, i_set_ma: p.iSetMa, v_set_mv: p.vSetMv,
			cc_s: p.ccS, cv_s: p.cvS, r_start_mohm: p.rStartMohm, r_end_mohm: p.rEndMohm
		};
		const names = Object.keys(columns);
		await this.db.query(
			`INSERT INTO battery_phases (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})
			ON DUPLICATE KEY UPDATE ${names.filter((n) => n !== 'started_at').map((n) => `${n} = VALUES(${n})`).join(', ')}`,
			Object.values(columns)
		);
	}
}
