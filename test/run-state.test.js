import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentDirection, RunStateTracker, runStateSql, withEffectiveRunState } from '../lib/run-state.js';
import { checkLimits } from '../supervisor/interlock.js';

const T0 = new Date(2026, 9, 3, 10, 0).getTime();

test('direction from the current, with a threshold', () => {
	assert.equal(currentDirection(500), 1);
	assert.equal(currentDirection(-500), 2);
	assert.equal(currentDirection(-19), 0);
	assert.equal(currentDirection(null), 0);
	assert.equal(currentDirection(-30, 50), 0);
});

test('the register reads 1 in discharge: the current gives the direction', () => {
	const tracker = new RunStateTracker();
	assert.equal(tracker.update(0, 0, T0), 0);
	assert.equal(tracker.update(1, -500, T0 + 1000), 2);
	// End of discharge at the voltage setpoint: current near zero, still discharge
	assert.equal(tracker.update(1, -5, T0 + 2000), 2);
	assert.equal(tracker.update(0, 0, T0 + 3000), 0);
	assert.equal(tracker.update(1, 800, T0 + 4000), 1);
	assert.equal(tracker.update(1, 3, T0 + 5000), 1, 'end of CV: still charge');
	// A register that does report 2 works the same way
	assert.equal(new RunStateTracker().update(2, -500, T0), 2);
	// Unknown codes pass through, for the rules
	assert.equal(tracker.update(7, -500, T0 + 6000), 7);
});

test('before the current is established: the commanded mode, then the raw value', () => {
	const tracker = new RunStateTracker();
	tracker.update(0, 0, T0);
	tracker.command(2, T0);
	assert.equal(tracker.update(1, 0, T0 + 1000), 2, 'discharge commanded, current not yet visible');
	assert.equal(tracker.update(1, -500, T0 + 2000), 2);

	// State before the ack: raw value first, corrected by the ack
	const early = new RunStateTracker();
	assert.equal(early.update(1, 0, T0), 1);
	early.command(2, T0 + 100);
	assert.equal(early.update(1, 0, T0 + 1000), 2);

	// An old command is not a hint any more
	const stale = new RunStateTracker();
	stale.command(2, T0);
	stale.update(0, 0, T0 + 60000);
	assert.equal(stale.update(1, 0, T0 + 120000), 1);

	const stopped = new RunStateTracker();
	stopped.command(2, T0);
	stopped.command(0, T0 + 500);
	assert.equal(stopped.update(1, 0, T0 + 1000), 1);
});

test('the interlock sees the discharge: minimum voltage and discharge current', () => {
	const tracker = new RunStateTracker();
	const limits = { vMin: 3000, vMax: 4230, iChargeMax: 1300, iDischargeMax: 2600, tempMax: 45, maxPhaseDuration: 28800 };
	const raw = { runState: 1, currentMeasuredMa: -500, voltageMeasuredMv: 2950, currentSetpointMa: 500, voltageSetpointMv: 2900 };
	const state = withEffectiveRunState(raw, tracker, T0);
	assert.equal(state.runState, 2);
	assert.equal(state.runStateRaw, 1);
	assert.deepEqual(checkLimits({ state, ntcTemperature: 25, phaseSeconds: 10 }, limits).map((v) => v.limit), ['vMin']);
	// 2000 mA in discharge is within iDischargeMax, not compared with iChargeMax
	const fast = withEffectiveRunState({ ...raw, currentMeasuredMa: -2000, voltageMeasuredMv: 3600 }, tracker, T0 + 1000);
	assert.deepEqual(checkLimits({ state: fast, ntcTemperature: 25, phaseSeconds: 10 }, limits), []);
});

test('SQL version of the rule', () => {
	assert.equal(runStateSql(), 'CASE WHEN run_state IN (1, 2) AND current_measured_ma <= -20 THEN 2 WHEN run_state IN (1, 2) AND current_measured_ma >= 20 THEN 1 ELSE run_state END');
});
