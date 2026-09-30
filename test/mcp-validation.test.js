import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandBounds, validateBatteryCommand } from '../mcp/validation.js';

const config = {
	commands: { voltageMarginMv: 30, currentMarginPct: 5, temperatureMarginC: 5, temperatureMaxAgeSeconds: 60, batteryMaxAgeSeconds: 10 },
	status: { maxAgeSeconds: 20 }
};
const LIMITS = { vMin: 3000, vMax: 4230, iChargeMax: 1300, iDischargeMax: 2600, tempMax: 45, maxPhaseDuration: 28800 };
const NOW = Date.parse('2026-09-30T10:00:00Z');

function status(overrides = {}, battery = {}) {
	return {
		online: true,
		at: new Date(NOW - 2000).toISOString(),
		profile: { name: 'liion', usable: true, limits: LIMITS },
		interlock: { armed: true, latched: null },
		live: {
			lab: { ntc_temperature: { value: 24, ageSeconds: 1, invalid: false } },
			battery: { runState: 0, voltageMeasuredMv: 3700, currentMeasuredMa: 0, voltageSetpointMv: 4200, currentSetpointMa: 800, batteryType: 0, ageSeconds: 1, ...battery }
		},
		...overrides
	};
}

const check = (cmd, st) => validateBatteryCommand(cmd, { status: st, now: NOW, config });

test('command bounds are stricter than the interlock limits', () => {
	assert.deepEqual(commandBounds(LIMITS, config.commands), {
		voltageMinMv: 3030, voltageMaxMv: 4200, chargeCurrentMaxMa: 1235, dischargeCurrentMaxMa: 2470, temperatureMaxC: 40
	});
});

test('the stop is always allowed, even without status or profile', () => {
	assert.equal(check({ command: 'set_run_state', value: 0 }, null).ok, true);
	assert.equal(check({ command: 'set_run_state', value: 0 }, status({ interlock: { latched: { reasons: ['x'] } } })).ok, true);
});

test('write_register and invalid values are refused', () => {
	assert.equal(check({ command: 'write_register', value: 1 }, status()).ok, false);
	assert.equal(check({ command: 'set_current_ma', value: 1.5 }, status()).ok, false);
	assert.equal(check({ command: 'set_current_ma', value: -100 }, status()).ok, false);
	assert.equal(check({ command: 'set_run_state', value: 3 }, status()).ok, false);
});

test('default deny: stale status, latched interlock, unusable profile, stale battery', () => {
	assert.match(check({ command: 'set_current_ma', value: 500 }, status({ at: new Date(NOW - 60000).toISOString() })).reason, /vecchio/);
	assert.match(check({ command: 'set_current_ma', value: 500 }, status({ online: false })).reason, /non raggiungibile/);
	assert.match(check({ command: 'set_current_ma', value: 500 }, status({ interlock: { latched: { reasons: ['vMax'] } } })).reason, /interblocco/);
	assert.match(check({ command: 'set_current_ma', value: 500 }, status({ profile: { usable: false, reasons: ['profile is a placeholder'] } })).reason, /profilo/);
	assert.match(check({ command: 'set_current_ma', value: 500 }, status({}, { ageSeconds: 30 })).reason, /batteria vecchi/);
});

test('setpoints: voltage window and current per mode', () => {
	assert.equal(check({ command: 'set_voltage_mv', value: 4200 }, status()).ok, true);
	assert.equal(check({ command: 'set_voltage_mv', value: 4201 }, status()).ok, false);
	assert.equal(check({ command: 'set_voltage_mv', value: 3000 }, status()).ok, false);
	// Stopped: the larger of the two limits; charging: the charge limit
	assert.equal(check({ command: 'set_current_ma', value: 2000 }, status()).ok, true);
	assert.equal(check({ command: 'set_current_ma', value: 2000 }, status({}, { runState: 1 })).ok, false);
	assert.equal(check({ command: 'set_current_ma', value: 1235 }, status({}, { runState: 1 })).ok, true);
	assert.equal(check({ command: 'set_current_ma', value: 2000 }, status({}, { runState: 2 })).ok, true);
});

test('start: checks the resulting state before running', () => {
	assert.equal(check({ command: 'set_run_state', value: 1 }, status()).ok, true);
	assert.equal(check({ command: 'set_run_state', value: 2 }, status()).ok, true);
	assert.match(check({ command: 'set_run_state', value: 1 }, status({}, { currentSetpointMa: 2000 })).reason, /massimo per la carica/);
	assert.match(check({ command: 'set_run_state', value: 2 }, status({}, { runState: 1 })).reason, /fermare prima/);
	assert.match(check({ command: 'set_run_state', value: 1 }, status({}, { runState: 1 })).reason, /già in carica/);
	assert.match(check({ command: 'set_run_state', value: 1 }, status({}, { voltageMeasuredMv: 4200 })).reason, /limite di carica/);
	assert.match(check({ command: 'set_run_state', value: 2 }, status({}, { voltageMeasuredMv: 3030 })).reason, /limite di scarica/);
	assert.match(check({ command: 'set_run_state', value: 1 }, status({}, { voltageSetpointMv: 4300 })).reason, /setpoint di tensione/);
});

test('start: needs a fresh NTC temperature below the start limit', () => {
	const noNtc = status();
	noNtc.live.lab = {};
	assert.match(check({ command: 'set_run_state', value: 1 }, noNtc).reason, /NTC non disponibile/);
	const hot = status();
	hot.live.lab.ntc_temperature.value = 41;
	assert.match(check({ command: 'set_run_state', value: 1 }, hot).reason, /sopra il massimo/);
	const old = status();
	old.live.lab.ntc_temperature.ageSeconds = 90;
	assert.match(check({ command: 'set_run_state', value: 1 }, old).reason, /NTC non disponibile/);
});
