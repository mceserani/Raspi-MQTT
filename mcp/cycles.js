import { formatLocal, roundValue } from './format.js';

// get_battery_cycles: the phases written by the supervisor (battery_phases),
// paired into cycles. A cycle is a discharge preceded by a charge of the same
// battery type: coulombic efficiency = discharged mAh / charged mAh, energy
// efficiency = discharged Wh / charged Wh.

const STATES = { 0: 'ferma', 1: 'carica', 2: 'scarica' };

export const PHASE_COLUMNS = ['id', 'start', 'end', 'state', 'batteryType', 'minutes', 'mAh', 'Wh', 'currentSign', 'vStartMv', 'vEndMv', 'vMinMv', 'vMaxMv', 'iAvgMa', 'iSetMa', 'vSetMv', 'ccMin', 'cvMin', 'rStartMohm', 'rEndMohm', 'endedBy', 'gapS'];

const n = (value) => (value === null || value === undefined ? null : Number(value));

export function phaseFromRow(row) {
	return {
		id: Number(row.id),
		start: new Date(row.started_at).getTime(),
		end: new Date(row.ended_at).getTime(),
		state: n(row.run_state),
		batteryType: n(row.battery_type),
		durationS: Number(row.duration_s),
		mah: Number(row.charge_mah),
		wh: Number(row.energy_wh),
		currentSign: Number(row.current_sign),
		vStart: n(row.v_start_mv),
		vEnd: n(row.v_end_mv),
		vMin: n(row.v_min_mv),
		vMax: n(row.v_max_mv),
		iAvg: n(row.i_avg_ma),
		iSet: n(row.i_set_ma),
		vSet: n(row.v_set_mv),
		ccS: Number(row.cc_s),
		cvS: Number(row.cv_s),
		rStart: n(row.r_start_mohm),
		rEnd: n(row.r_end_mohm),
		endReason: row.end_reason,
		nextState: n(row.next_state),
		gapS: Number(row.gap_s)
	};
}

function phaseRow(p) {
	const endedBy = p.endReason === 'data_gap' ? 'buco nei dati' : STATES[p.nextState] ?? `stato ${p.nextState}`;
	return [
		p.id, formatLocal(p.start, { seconds: false }), formatLocal(p.end, { seconds: false }), STATES[p.state] ?? p.state, p.batteryType,
		roundValue(p.durationS / 60, 0), roundValue(p.mah, 0), roundValue(p.wh, 2), p.currentSign,
		p.vStart, p.vEnd, p.vMin, p.vMax, roundValue(p.iAvg, 0), p.iSet, p.vSet,
		roundValue(p.ccS / 60, 0), roundValue(p.cvS / 60, 0), roundValue(p.rStart, 0), roundValue(p.rEnd, 0), endedBy, p.gapS
	];
}

export function pairCycles(phases, { maxRestHours = 24 } = {}) {
	const cycles = [];
	for (let k = 1; k < phases.length; k++) {
		const charge = phases[k - 1];
		const discharge = phases[k];
		if (charge.state !== 1 || discharge.state !== 2 || charge.batteryType !== discharge.batteryType) continue;
		const restMs = discharge.start - charge.end;
		if (restMs < 0 || restMs > maxRestHours * 3600000) continue;
		cycles.push({
			charge: charge.id,
			discharge: discharge.id,
			at: formatLocal(discharge.start, { seconds: false }),
			restMin: roundValue(restMs / 60000, 0),
			chargeMah: roundValue(charge.mah, 0),
			dischargeMah: roundValue(discharge.mah, 0),
			coulombicPct: charge.mah > 0 ? roundValue((discharge.mah / charge.mah) * 100, 1) : null,
			chargeWh: roundValue(charge.wh, 2),
			dischargeWh: roundValue(discharge.wh, 2),
			energyPct: charge.wh > 0 ? roundValue((discharge.wh / charge.wh) * 100, 1) : null,
			...(charge.endReason === 'data_gap' || discharge.endReason === 'data_gap' || charge.gapS + discharge.gapS > 60 ? { incomplete: true } : {})
		});
	}
	return cycles;
}

// Sign of the measured current in each mode, as observed: answers whether the
// discharge current is negative without trusting a convention
export function observedSigns(phases) {
	const out = {};
	for (const state of [1, 2]) {
		const signs = phases.filter((p) => p.state === state && p.currentSign !== 0).map((p) => p.currentSign);
		if (!signs.length) continue;
		const plus = signs.filter((s) => s > 0).length;
		const minus = signs.length - plus;
		out[STATES[state]] = plus && minus ? `misto (${plus} positive, ${minus} negative)` : plus ? 'positiva' : 'negativa';
	}
	return out;
}

// The phase still open in the supervisor (state key "cycles")
export function inProgressFrom(saved, now) {
	const o = saved?.open;
	if (!o) return null;
	return {
		state: STATES[o.state] ?? o.state,
		since: formatLocal(o.startT, { seconds: false }),
		minutes: roundValue((o.lastT - o.startT) / 60000, 0),
		mAh: roundValue(Math.abs(o.q) / 3600, 0),
		Wh: roundValue(Math.abs(o.e) / 3.6e9, 2),
		currentSign: Math.sign(o.q),
		lastDataAgeMin: roundValue((now - o.lastT) / 60000, 0)
	};
}

export function buildCyclesResult({ rows, truncated, saved, now, sinceMs, maxRestHours }) {
	const phases = rows.map(phaseFromRow).sort((a, b) => a.start - b.start);
	return {
		since: formatLocal(sinceMs, { seconds: false }),
		legend: 'phases: una riga per carica o scarica (mAh ed Wh in valore assoluto; currentSign = segno della corrente misurata; ccMin/cvMin = minuti a corrente/tensione di setpoint; rStartMohm/rEndMohm = resistenza interna stimata dal salto di tensione all\'avvio e allo stop; endedBy = stato successivo o buco nei dati; gapS = secondi non integrati). cycles: scarica preceduta da una carica dello stesso tipo, con efficienza coulombica ed energetica; incomplete = buchi nei dati. Confrontare le capacità solo tra scariche con corrente e tensioni simili.',
		columns: PHASE_COLUMNS,
		phases: phases.map(phaseRow),
		...(truncated ? { truncated: true, note: 'troppe fasi: mostrate le più recenti; ridurre since' } : {}),
		cycles: pairCycles(phases, { maxRestHours }),
		currentSign: observedSigns(phases),
		inProgress: inProgressFrom(saved, now)
	};
}
