import { test } from 'node:test';
import assert from 'node:assert/strict';
import mqtt from 'mqtt';
import { BatteryModel, LabModel, labsensEncode } from '../tools/simulator.js';
import { startDevBroker } from '../tools/dev-broker.js';

test('labsensEncode reproduces the unsigned-register sign bug', () => {
	assert.equal(labsensEncode(21.5, 100), 21.5);
	assert.equal(labsensEncode(-1.5, 100), 653.86);
	assert.equal(labsensEncode(-0.5, 10), 6553.1);
});

test('lab overrides are published as-is', () => {
	const lab = new LabModel();
	lab.overrides.set('pm2_5', 300);
	assert.equal(lab.read().pm2_5, 300);
});

test('CC/CV charge: current tapers and voltage stays near the setpoint', () => {
	const battery = new BatteryModel({ soc: 0.1 });
	battery.applyCommand({ command: 'set_current_ma', value: 1000 });
	battery.applyCommand({ command: 'set_voltage_mv', value: 4200 });
	battery.applyCommand({ command: 'set_run_state', value: 1 });

	battery.step(1);
	assert.equal(battery.currentMa, 1000);

	for (let i = 0; i < 4 * 3600; i++) battery.step(1);
	assert.ok(battery.currentMa < 100, `current should taper, got ${battery.currentMa}`);
	assert.ok(Math.abs(battery.read().voltageMeasuredMv - 4200) < 10);
});

test('like the bench, no charge above nor discharge below the voltage setpoint', () => {
	const battery = new BatteryModel({ soc: 0.3 });
	battery.applyCommand({ command: 'set_run_state', value: 2 });
	assert.equal(battery.runState, 0, 'discharge with the setpoint at 4200 mV does not start');
	battery.applyCommand({ command: 'set_voltage_mv', value: 3200 });
	battery.applyCommand({ command: 'set_run_state', value: 1 });
	assert.equal(battery.runState, 0, 'charge with the setpoint below the voltage does not start');
	battery.applyCommand({ command: 'set_run_state', value: 2 });
	assert.equal(battery.runState, 2);
	for (let i = 0; i < 4 * 3600; i++) battery.step(1);
	assert.ok(Math.abs(battery.ocvMv - 3200) < 10, `discharge stops at the setpoint, got ${battery.ocvMv}`);
});

test('discharge gives negative current and stops at empty', () => {
	const battery = new BatteryModel({ soc: 0.01 });
	battery.applyCommand({ command: 'set_voltage_mv', value: 2900 });
	battery.applyCommand({ command: 'set_run_state', value: 2 });
	battery.step(1);
	assert.ok(battery.currentMa < 0);
	for (let i = 0; i < 3600; i++) battery.step(1);
	assert.equal(battery.soc, 0);
	assert.equal(battery.currentMa, 0);
});

test('invalid commands are rejected like battery-mqtt.js', () => {
	const battery = new BatteryModel();
	assert.throws(() => battery.applyCommand({ command: 'set_run_state', value: 5 }));
	assert.throws(() => battery.applyCommand({ command: 'set_current_ma', value: 1.5 }));
	assert.throws(() => battery.applyCommand({ command: 'explode', value: 1 }));
	assert.equal(battery.applyCommand({ command: 'write_register', register: 405, value: 3 }).register, 405);
	assert.equal(battery.batteryType, 3);
});

test('faults alter the measured values', () => {
	const battery = new BatteryModel();
	const normal = battery.read().voltageMeasuredMv;
	battery.fault = 'overvoltage';
	assert.ok(battery.read().voltageMeasuredMv - normal > 700);
});

test('dev broker delivers messages', async () => {
	const broker = await startDevBroker(0);
	const client = await mqtt.connectAsync(broker.url);
	try {
		await client.subscribeAsync('t/x');
		const received = new Promise((resolve) => client.once('message', (_topic, payload) => resolve(payload.toString())));
		await client.publishAsync('t/x', 'hello');
		assert.equal(await received, 'hello');
	} finally {
		await client.endAsync();
		await broker.close();
	}
});
