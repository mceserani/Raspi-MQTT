import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLimits, Interlock } from '../supervisor/interlock.js';
import { batteryState, LIMITS, loadConfig } from './helpers.js';

const config = (await loadConfig()).interlock;
const profile = { limits: LIMITS };
const T0 = 1_000_000_000;
const ntcAt = (t, value = 25) => ({ value, at: t });

function setup(overrides = {}) {
	const stops = [];
	const latches = [];
	const interlock = new Interlock({ ...config, ...overrides }, {
		sendStop: (source) => stops.push(source),
		onLatchChange: (latched) => latches.push(latched)
	});
	return { interlock, stops, latches };
}

test('checkLimits: each limit', () => {
	const limitsOf = (state, extra = {}) => checkLimits({ state: batteryState(state), ntcTemperature: 25, phaseSeconds: 10, ...extra }, LIMITS).map((v) => v.limit);
	assert.deepEqual(limitsOf({}), []);
	assert.deepEqual(limitsOf({ voltageMeasuredMv: 4300 }), ['vMax']);
	assert.deepEqual(limitsOf({ runState: 2, voltageMeasuredMv: 2900, currentMeasuredMa: -500 }), ['vMin']);
	assert.deepEqual(limitsOf({ runState: 1, voltageMeasuredMv: 2900 }), [], 'low voltage allowed while charging');
	assert.deepEqual(limitsOf({ currentMeasuredMa: 1200 }), ['iChargeMax']);
	assert.deepEqual(limitsOf({ runState: 2, currentMeasuredMa: -1600 }), ['iDischargeMax']);
	assert.deepEqual(limitsOf({}, { ntcTemperature: 50 }), ['tempMax']);
	assert.deepEqual(limitsOf({}, { phaseSeconds: 4000 }), ['maxPhaseDuration']);
});

test('trips after confirmSamples consecutive violations and latches', () => {
	const { interlock, stops, latches } = setup();
	const bad = batteryState({ voltageMeasuredMv: 4300 });

	for (let i = 0; i < config.confirmSamples - 1; i++) {
		interlock.onBatteryState(bad, { profile, profileName: 'p', ntc: ntcAt(T0) }, T0 + i * 1000);
	}
	assert.equal(stops.length, 0);

	interlock.onBatteryState(bad, { profile, profileName: 'p', ntc: ntcAt(T0) }, T0 + config.confirmSamples * 1000);
	assert.deepEqual(stops, ['interlock']);
	assert.equal(latches.length, 1);
	assert.equal(interlock.drainEvents()[0].key, 'interlock:trip');
	assert.ok(interlock.conditions().some((c) => c.key === 'interlock:latched'));
});

test('an isolated bad sample does not trip', () => {
	const { interlock, stops } = setup();
	interlock.onBatteryState(batteryState({ voltageMeasuredMv: 4300 }), { profile, ntc: ntcAt(T0) }, T0);
	interlock.onBatteryState(batteryState(), { profile, ntc: ntcAt(T0) }, T0 + 1000);
	interlock.onBatteryState(batteryState({ voltageMeasuredMv: 4300 }), { profile, ntc: ntcAt(T0) }, T0 + 2000);
	assert.equal(stops.length, 0);
});

test('stop confirmed when the battery reports stopped', () => {
	const { interlock } = setup({ confirmSamples: 1 });
	interlock.onBatteryState(batteryState({ voltageMeasuredMv: 4300 }), { profile, ntc: ntcAt(T0) }, T0);
	interlock.drainEvents();
	interlock.onBatteryState(batteryState({ runState: 0, currentMeasuredMa: 0 }), { profile, ntc: ntcAt(T0) }, T0 + 1500);
	assert.equal(interlock.drainEvents()[0].key, 'interlock:stopped');
	assert.ok(!interlock.conditions().some((c) => c.key === 'interlock:stop_failed'));
});

test('retries the stop and raises stop_failed if the battery keeps running', () => {
	const { interlock, stops } = setup({ confirmSamples: 1 });
	const bad = batteryState({ voltageMeasuredMv: 4300 });
	let t = T0;
	interlock.onBatteryState(bad, { profile, ntc: ntcAt(t) }, t);
	for (let i = 0; i < 30; i++) {
		t += 1000;
		interlock.onBatteryState(bad, { profile, ntc: ntcAt(t) }, t);
	}
	assert.equal(stops.length, config.stopRetries);
	assert.ok(interlock.conditions().some((c) => c.key === 'interlock:stop_failed' && c.severity === 'critical'));
});

test('no action without a usable profile or when stopped', () => {
	const { interlock, stops } = setup({ confirmSamples: 1 });
	interlock.onBatteryState(batteryState({ voltageMeasuredMv: 4300 }), { profile: null, ntc: ntcAt(T0) }, T0);
	interlock.onBatteryState(batteryState({ runState: 0, voltageMeasuredMv: 4300 }), { profile, ntc: ntcAt(T0) }, T0 + 1000);
	assert.equal(stops.length, 0);
});

test('missing NTC temperature stops the battery when configured', () => {
	const { interlock, stops } = setup({ confirmSamples: 1 });
	const oldNtc = ntcAt(T0 - (config.temperatureStaleSeconds + 1) * 1000);
	interlock.onBatteryState(batteryState(), { profile, ntc: oldNtc }, T0);
	assert.equal(stops.length, 1);

	const lenient = setup({ confirmSamples: 1, stopOnMissingTemperature: false });
	lenient.interlock.onBatteryState(batteryState(), { profile, ntc: null }, T0);
	assert.equal(lenient.stops.length, 0);
});

test('phase duration counts from the start of the phase', () => {
	const { interlock, stops } = setup({ confirmSamples: 1 });
	interlock.onBatteryState(batteryState({ runState: 0 }), { profile, ntc: ntcAt(T0) }, T0);
	const start = T0 + 1000;
	interlock.onBatteryState(batteryState(), { profile, ntc: ntcAt(start) }, start);
	const late = start + (LIMITS.maxPhaseDuration - 1) * 1000;
	interlock.onBatteryState(batteryState(), { profile, ntc: ntcAt(late) }, late);
	assert.equal(stops.length, 0);
	const over = start + (LIMITS.maxPhaseDuration + 1) * 1000;
	interlock.onBatteryState(batteryState(), { profile, ntc: ntcAt(over) }, over);
	assert.equal(stops.length, 1);
});

test('reset clears the latch', () => {
	const { interlock, latches } = setup({ confirmSamples: 1 });
	interlock.onBatteryState(batteryState({ voltageMeasuredMv: 4300 }), { profile, ntc: ntcAt(T0) }, T0);
	interlock.reset();
	assert.equal(interlock.latched, null);
	assert.equal(latches.at(-1), null);
});
