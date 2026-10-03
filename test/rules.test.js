import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleEngine } from '../supervisor/rules.js';
import { batteryState, loadConfig } from './helpers.js';

const config = await loadConfig();
const T0 = 1_000_000_000;
const usable = () => ({ usable: true });

function keys(result) {
	return result.conditions.map((c) => c.key).sort();
}

// Feeds every lab sensor with a normal value, one sample per second
function feedLab(engine, from, to, overrides = {}) {
	const normal = { temperature: 22, humidity: 45, pm2_5: 7, pm10: 12, voc: 100, nox: 1, ntc_temperature: 22.5, co2: 600 };
	for (let t = from; t <= to; t += 1000) {
		for (const [sensor, value] of Object.entries({ ...normal, ...overrides })) {
			engine.onLab(sensor, value, t);
		}
	}
}

test('no conditions with normal data', () => {
	const engine = new RuleEngine(config, { profileProvider: usable });
	engine.evaluate(T0);
	feedLab(engine, T0, T0 + 10_000);
	engine.onBattery(batteryState({ runState: 0 }), T0 + 10_000);
	assert.deepEqual(keys(engine.evaluate(T0 + 10_000)), []);
});

test('threshold opens only after sustain, escalates, and closes with hysteresis', () => {
	const engine = new RuleEngine(config, { profileProvider: usable });
	engine.evaluate(T0);
	const sustain = config.lab.sensors.pm2_5.sustain * 1000;
	const windowMs = config.lab.sensors.pm2_5.window * 1000;

	feedLab(engine, T0, T0 + windowMs, { pm2_5: 40 });
	assert.ok(!keys(engine.evaluate(T0 + windowMs)).includes('lab:threshold:pm2_5:high'), 'not before sustain');

	feedLab(engine, T0 + windowMs, T0 + windowMs + sustain, { pm2_5: 40 });
	let result = engine.evaluate(T0 + windowMs + sustain);
	const condition = result.conditions.find((c) => c.key === 'lab:threshold:pm2_5:high');
	assert.equal(condition?.severity, 'warning');

	let t = T0 + windowMs + sustain;
	feedLab(engine, t, t + windowMs, { pm2_5: 100 });
	t += windowMs;
	result = engine.evaluate(t);
	assert.equal(result.conditions.find((c) => c.key === 'lab:threshold:pm2_5:high').severity, 'critical', 'escalation is immediate');

	// 33 is under the warning threshold (35) but inside the hysteresis (3): still active
	feedLab(engine, t, t + windowMs, { pm2_5: 33 });
	t += windowMs;
	assert.equal(engine.evaluate(t).conditions.find((c) => c.key === 'lab:threshold:pm2_5:high').severity, 'warning');

	feedLab(engine, t, t + windowMs, { pm2_5: 20 });
	t += windowMs;
	assert.ok(!keys(engine.evaluate(t)).includes('lab:threshold:pm2_5:high'));
});

test('a short spike does not open a threshold event', () => {
	const engine = new RuleEngine(config, { profileProvider: usable });
	engine.evaluate(T0);
	feedLab(engine, T0, T0 + 60_000);
	feedLab(engine, T0 + 61_000, T0 + 65_000, { pm2_5: 500 });
	feedLab(engine, T0 + 66_000, T0 + 300_000);
	for (let t = T0; t <= T0 + 300_000; t += 1000) {
		assert.ok(!keys(engine.evaluate(t)).includes('lab:threshold:pm2_5:high'));
	}
});

test('low threshold on temperature', () => {
	const engine = new RuleEngine(config, { profileProvider: usable });
	engine.evaluate(T0);
	for (let t = T0; t < T0 + 200_000; t += 1000) {
		feedLab(engine, t, t, { temperature: 12 });
		engine.evaluate(t);
	}
	feedLab(engine, T0 + 200_000, T0 + 200_000, { temperature: 12 });
	const condition = engine.evaluate(T0 + 200_000).conditions.find((c) => c.key === 'lab:threshold:temperature:low');
	assert.equal(condition.severity, 'warning');
});

test('stale lab data and stale battery', () => {
	const engine = new RuleEngine(config, { profileProvider: usable });
	engine.evaluate(T0);
	feedLab(engine, T0, T0 + 5000);
	engine.onBattery(batteryState({ runState: 1 }), T0 + 5000);
	const later = T0 + 5000 + (config.lab.staleSeconds + 1) * 1000;
	const result = engine.evaluate(later);
	assert.ok(keys(result).includes('lab:stale'));
	assert.equal(result.conditions.find((c) => c.key === 'battery:stale').severity, 'critical', 'running battery without data is critical');
});

test('never-received battery data becomes stale after the grace period', () => {
	const engine = new RuleEngine(config, { profileProvider: usable });
	engine.evaluate(T0);
	assert.ok(!keys(engine.evaluate(T0 + 5000)).includes('battery:stale'));
	assert.ok(keys(engine.evaluate(T0 + (config.battery.staleSeconds + 1) * 1000)).includes('battery:stale'));
});

test('CO2: info, two warning steps, critical, after the sustain', () => {
	const engine = new RuleEngine(config, { profileProvider: usable });
	engine.evaluate(T0);
	const sustain = config.lab.sensors.co2.sustain * 1000;
	const co2At = (from, to, co2) => {
		let result;
		for (let t = from; t <= to; t += 1000) {
			feedLab(engine, t, t, { co2 });
			result = engine.evaluate(t);
		}
		return result.conditions.find((c) => c.key === 'lab:threshold:co2:high');
	};
	assert.equal(co2At(T0, T0 + sustain - 120_000, 1100), undefined, 'not before the sustain');
	let condition = co2At(T0 + sustain - 119_000, T0 + sustain + 60_000, 1100);
	assert.deepEqual([condition.severity, condition.step, condition.details.limit], ['info', 0, 1000]);
	// The 60 s window mean follows the new value
	condition = co2At(T0 + sustain + 61_000, T0 + sustain + 200_000, 1600);
	assert.deepEqual([condition.severity, condition.step, condition.details.limit], ['warning', 1, 1500]);
	condition = co2At(T0 + sustain + 201_000, T0 + sustain + 300_000, 2100);
	assert.deepEqual([condition.severity, condition.step], ['warning', 2]);
	assert.match(condition.message, /^CO2 alta: 2100 ppm \(soglia 2000\)$/);
	// Hysteresis: 1970 ppm keeps the 2000 step (margin 50)
	condition = co2At(T0 + sustain + 301_000, T0 + sustain + 400_000, 1970);
	assert.equal(condition.step, 2);
	condition = co2At(T0 + sustain + 401_000, T0 + sustain + 500_000, 5200);
	assert.deepEqual([condition.severity, condition.step], ['critical', 3]);
	assert.equal(co2At(T0 + sustain + 501_000, T0 + sustain + 600_000, 600), undefined);
});

test('implausible reading and rate of change', () => {
	const engine = new RuleEngine(config, { profileProvider: usable });
	engine.evaluate(T0);
	feedLab(engine, T0, T0 + 30_000);
	engine.onLab('humidity', 150, T0 + 30_000);
	feedLab(engine, T0 + 31_000, T0 + 35_000, { humidity: 45, temperature: 28 });
	engine.onLab('humidity', 150, T0 + 35_000);
	const result = keys(engine.evaluate(T0 + 35_000));
	assert.ok(result.includes('lab:invalid:humidity'));
	assert.ok(result.includes('lab:rate:temperature'), 'temperature jumped 6 °C');
});

test('battery current deviation in CC charge, but not in CV phase', () => {
	const engine = new RuleEngine(config, { profileProvider: usable });
	engine.evaluate(T0);
	const settle = config.battery.settleSeconds * 1000;
	const sustain = config.battery.sustain * 1000;

	engine.onBattery(batteryState({ currentMeasuredMa: 300, voltageMeasuredMv: 3700 }), T0);
	for (let t = T0; t <= T0 + settle + sustain; t += 1000) {
		engine.onBattery(batteryState({ currentMeasuredMa: 300, voltageMeasuredMv: 3700 }), t);
		feedLab(engine, t, t);
		engine.evaluate(t);
	}
	assert.ok(keys(engine.evaluate(T0 + settle + sustain)).includes('battery:current_deviation'));

	const cv = new RuleEngine(config, { profileProvider: usable });
	cv.evaluate(T0);
	for (let t = T0; t <= T0 + settle + sustain; t += 1000) {
		cv.onBattery(batteryState({ currentMeasuredMa: 100, voltageMeasuredMv: 4195 }), t);
		feedLab(cv, t, t);
		cv.evaluate(t);
	}
	assert.ok(!keys(cv.evaluate(T0 + settle + sustain)).includes('battery:current_deviation'));
});

test('discharge current is compared in absolute value', () => {
	const engine = new RuleEngine(config, { profileProvider: usable });
	engine.evaluate(T0);
	const end = T0 + (config.battery.settleSeconds + config.battery.sustain + 1) * 1000;
	for (let t = T0; t <= end; t += 1000) {
		engine.onBattery(batteryState({ runState: 2, currentMeasuredMa: -500 }), t);
		feedLab(engine, t, t);
		engine.evaluate(t);
	}
	assert.ok(!keys(engine.evaluate(end)).includes('battery:current_deviation'));
});

test('discharge: current below the setpoint only far from the voltage setpoint', () => {
	const run = (voltageMeasuredMv) => {
		const engine = new RuleEngine(config, { profileProvider: usable });
		engine.evaluate(T0);
		const end = T0 + (config.battery.settleSeconds + config.battery.sustain + 1) * 1000;
		for (let t = T0; t <= end; t += 1000) {
			engine.onBattery(batteryState({ runState: 2, currentMeasuredMa: -323, voltageSetpointMv: 3200, voltageMeasuredMv }), t);
			feedLab(engine, t, t);
			engine.evaluate(t);
		}
		return keys(engine.evaluate(end)).includes('battery:current_deviation');
	};
	// Seen on the Pi on 2026-10-03: voltage settled at 3225 mV, current 500 -> 323 mA
	assert.equal(run(3225), false);
	assert.equal(run(3600), true);
});

test('running battery without a usable profile', () => {
	const engine = new RuleEngine(config, { profileProvider: () => ({ usable: false }) });
	engine.evaluate(T0);
	engine.onBattery(batteryState({ runState: 1 }), T0);
	assert.ok(keys(engine.evaluate(T0)).includes('battery:no_profile'));
});

test('run state change: commanded vs uncommanded', () => {
	const windowMs = config.battery.commandAckWindowSeconds * 1000;

	const commanded = new RuleEngine(config, { profileProvider: usable });
	commanded.evaluate(T0);
	commanded.onBattery(batteryState({ runState: 0 }), T0);
	commanded.onAck({ status: 'ok', command: 'set_run_state', value: 1 }, T0 + 500);
	commanded.onBattery(batteryState({ runState: 1 }), T0 + 1000);
	assert.equal(commanded.evaluate(T0 + 1000 + windowMs + 1).events.length, 0);

	const uncommanded = new RuleEngine(config, { profileProvider: usable });
	uncommanded.evaluate(T0);
	uncommanded.onBattery(batteryState({ runState: 0 }), T0);
	uncommanded.onBattery(batteryState({ runState: 1 }), T0 + 1000);
	assert.equal(uncommanded.evaluate(T0 + 2000).events.length, 0, 'waits for a late ack');
	const events = uncommanded.evaluate(T0 + 1000 + windowMs + 1).events;
	assert.equal(events[0]?.key, 'battery:uncommanded_run_state');
});

test('rejected command becomes a one-shot event', () => {
	const engine = new RuleEngine(config, { profileProvider: usable });
	engine.onAck({ status: 'error', command: 'set_current_ma', message: 'boom' }, T0);
	const { events } = engine.evaluate(T0);
	assert.equal(events[0].key, 'battery:command_error');
	assert.equal(engine.evaluate(T0 + 1000).events.length, 0, 'drained');
});

test('health conditions pass through', () => {
	const engine = new RuleEngine(config, { profileProvider: usable });
	engine.setHealth([{ key: 'health:inactive:x', source: 'health', type: 't', severity: 'critical', message: 'm', details: {} }]);
	assert.ok(keys(engine.evaluate(T0)).includes('health:inactive:x'));
});
