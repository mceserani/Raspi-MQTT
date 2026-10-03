// Effective run state of the battery bench (0 stopped, 1 charge, 2 discharge).
//
// The bench accepts set_run_state 2 and discharges, but its run state register
// (404) reads 1 during charge AND discharge (verified on 2026-10-03: run_state
// 2 never appears in battery_measurements, discharges are run_state 1 with a
// negative current). The register only tells whether the bench is running; the
// direction comes from the measured current, positive in charge and negative
// in discharge (verified on the bench on 2026-10-02). battery-mqtt.js is not
// modified: the raw value stays in the table and on MQTT.
//
// With the current near zero (start of a phase, end of CV) the direction is not
// visible: the mode already known is kept, else the run state just commanded
// (hint, from the command ack), else the raw value. A register that does report
// 2 works the same way.

export const RUN_STATE_CURRENT_MA = 20;
const HINT_MS = 30000;

const isActive = (raw) => raw === 1 || raw === 2;

// Direction of one sample from the current alone: 1, 2 or 0 (not visible)
export function currentDirection(currentMa, thresholdMa = RUN_STATE_CURRENT_MA) {
	if (typeof currentMa !== 'number' || !Number.isFinite(currentMa) || Math.abs(currentMa) < thresholdMa) return 0;
	return currentMa > 0 ? 1 : 2;
}

export class RunStateTracker {
	constructor({ thresholdMa = RUN_STATE_CURRENT_MA } = {}) {
		this.thresholdMa = thresholdMa;
		this.mode = 0;
		this.hint = null;
	}

	// A run state command was applied (ack): tells the mode before the
	// current is established
	command(value, now) {
		this.hint = isActive(value) ? { mode: value, at: now } : null;
		if (value === 0) return;
		if (this.hint && isActive(this.mode) && this.mode !== value) this.mode = 0;
	}

	update(raw, currentMa, now) {
		if (!isActive(raw)) {
			// Stopped, or an unknown code that the rules must see as it is
			this.mode = raw;
			return raw;
		}
		const direction = currentDirection(currentMa, this.thresholdMa);
		if (direction) {
			this.mode = direction;
		} else if (!isActive(this.mode)) {
			const hint = this.hint && now - this.hint.at <= HINT_MS ? this.hint.mode : null;
			this.mode = hint ?? raw;
		}
		return this.mode;
	}
}

// Battery state with the effective run state; the register value stays in
// runStateRaw
export function withEffectiveRunState(state, tracker, now) {
	return { ...state, runStateRaw: state.runState, runState: tracker.update(state.runState, state.currentMeasuredMa, now) };
}

// The same rule in SQL, for queries that group the raw rows by state: with the
// current near zero the raw value is kept (there is no history in a GROUP BY)
export function runStateSql(thresholdMa = RUN_STATE_CURRENT_MA) {
	const t = Number(thresholdMa);
	return `CASE WHEN run_state IN (1, 2) AND current_measured_ma <= -${t} THEN 2 WHEN run_state IN (1, 2) AND current_measured_ma >= ${t} THEN 1 ELSE run_state END`;
}
