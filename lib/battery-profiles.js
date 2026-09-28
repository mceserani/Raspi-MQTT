import { readFile } from 'node:fs/promises';

// Limits every usable profile must define (see docs/PIANO-AGENTE.md, 5.2)
export const LIMIT_FIELDS = [
	'vMin', // mV
	'vMax', // mV
	'iChargeMax', // mA, positive
	'iDischargeMax', // mA, positive
	'tempMax', // °C, from the NTC
	'maxPhaseDuration' // s
];

function isPositiveNumber(value) {
	return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

// Returns the list of problems of a single profile: an empty list means usable.
export function profileProblems(profile) {
	if (!profile || typeof profile !== 'object') {
		return ['profile must be an object'];
	}

	const problems = [];
	if (profile.placeholder === true) {
		problems.push('profile is a placeholder');
	}

	const limits = profile.limits ?? {};
	for (const field of LIMIT_FIELDS) {
		if (limits[field] === null || limits[field] === undefined) {
			problems.push(`limit ${field} is not defined`);
		} else if (!isPositiveNumber(limits[field])) {
			problems.push(`limit ${field} must be a positive number`);
		}
	}

	if (isPositiveNumber(limits.vMin) && isPositiveNumber(limits.vMax) && limits.vMin >= limits.vMax) {
		problems.push('vMin must be lower than vMax');
	}

	if (profile.batteryTypeCodes !== undefined && !Array.isArray(profile.batteryTypeCodes)) {
		problems.push('batteryTypeCodes must be an array');
	}

	return problems;
}

// Structural validation of the whole file. Placeholder profiles are allowed
// here: they are only refused when someone tries to act with them.
export function validateProfilesFile(data) {
	const errors = [];
	if (!data || typeof data !== 'object' || !data.profiles || typeof data.profiles !== 'object') {
		return ['file must contain a "profiles" object'];
	}

	const codeOwners = new Map();
	for (const [name, profile] of Object.entries(data.profiles)) {
		if (!profile || typeof profile !== 'object' || typeof profile.limits !== 'object' || profile.limits === null) {
			errors.push(`${name}: missing "limits" object`);
			continue;
		}

		for (const field of Object.keys(profile.limits)) {
			if (!LIMIT_FIELDS.includes(field)) {
				errors.push(`${name}: unknown limit "${field}"`);
			}
		}

		for (const code of profile.batteryTypeCodes ?? []) {
			if (!Number.isInteger(code)) {
				errors.push(`${name}: batteryTypeCodes must contain integers`);
			} else if (codeOwners.has(code)) {
				errors.push(`${name}: batteryType ${code} already used by ${codeOwners.get(code)}`);
			} else {
				codeOwners.set(code, name);
			}
		}
	}

	return errors;
}

export async function loadProfiles(filePath) {
	const data = JSON.parse(await readFile(filePath, 'utf8'));
	const errors = validateProfilesFile(data);
	if (errors.length > 0) {
		throw new Error(`Invalid battery profiles file ${filePath}:\n- ${errors.join('\n- ')}`);
	}

	return data;
}

// Chooses the active profile: a manual declaration (e.g. Telegram /battery)
// wins over the batteryType register. The result says whether acting is allowed.
export function resolveActiveProfile(data, { batteryType, manualProfile } = {}) {
	const profiles = data?.profiles ?? {};
	let name = null;
	let source = null;

	if (manualProfile) {
		if (!profiles[manualProfile]) {
			return { name: manualProfile, source: 'manual', profile: null, usable: false, reasons: ['unknown profile'] };
		}
		name = manualProfile;
		source = 'manual';
	} else if (Number.isInteger(batteryType)) {
		name = Object.keys(profiles).find((key) => profiles[key].batteryTypeCodes?.includes(batteryType)) ?? null;
		source = 'register';
	}

	if (!name) {
		return { name: null, source, profile: null, usable: false, reasons: ['no profile for this battery'] };
	}

	const reasons = profileProblems(profiles[name]);
	return { name, source, profile: profiles[name], usable: reasons.length === 0, reasons };
}
