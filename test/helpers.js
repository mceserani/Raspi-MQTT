import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSupervisorConfig } from '../supervisor/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function loadConfig() {
	return loadSupervisorConfig(path.join(here, '..', 'config', 'supervisor.json'));
}

export const LIMITS = { vMin: 3000, vMax: 4200, iChargeMax: 1000, iDischargeMax: 1500, tempMax: 45, maxPhaseDuration: 3600 };

export function batteryState(overrides = {}) {
	return {
		currentSetpointMa: 500,
		voltageSetpointMv: 4200,
		currentMeasuredMa: 500,
		voltageMeasuredMv: 3700,
		runState: 1,
		runStateLabel: 'charge',
		batteryType: 1,
		timestamp: new Date().toISOString(),
		...overrides
	};
}

export const silentLog = { log() {}, warn() {}, error() {} };
