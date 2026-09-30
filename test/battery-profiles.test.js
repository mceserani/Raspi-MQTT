import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProfiles, profileProblems, resolveActiveProfile, validateProfilesFile } from '../lib/battery-profiles.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const usableLimits = { vMin: 3000, vMax: 4200, iChargeMax: 1000, iDischargeMax: 1000, tempMax: 45, maxPhaseDuration: 14400 };

const sample = {
	profiles: {
		liion: { batteryTypeCodes: [1], limits: usableLimits },
		todo: { placeholder: true, batteryTypeCodes: [2], limits: { ...usableLimits } },
		partial: { batteryTypeCodes: [3], limits: { ...usableLimits, tempMax: null } }
	}
};

test('the repository profiles file is valid: real profiles are usable, placeholders are not', async () => {
	const data = await loadProfiles(path.join(here, '..', 'config', 'battery-profiles.json'));
	for (const [name, profile] of Object.entries(data.profiles)) {
		if (profile.placeholder === true) {
			assert.ok(profileProblems(profile).length > 0, name);
		} else {
			assert.deepEqual(profileProblems(profile), [], name);
		}
	}
});

test('a complete profile is usable', () => {
	assert.deepEqual(profileProblems(sample.profiles.liion), []);
});

test('placeholder, missing limits and inverted voltage window are refused', () => {
	assert.ok(profileProblems(sample.profiles.todo).includes('profile is a placeholder'));
	assert.ok(profileProblems(sample.profiles.partial).includes('limit tempMax is not defined'));
	assert.ok(profileProblems({ limits: { ...usableLimits, vMin: 5000 } }).includes('vMin must be lower than vMax'));
	assert.ok(profileProblems({ limits: { ...usableLimits, iChargeMax: -1 } }).includes('limit iChargeMax must be a positive number'));
});

test('file validation catches unknown limits and duplicated battery codes', () => {
	const errors = validateProfilesFile({
		profiles: {
			a: { batteryTypeCodes: [1], limits: { vMaxx: 1 } },
			b: { batteryTypeCodes: [1], limits: {} }
		}
	});
	assert.ok(errors.some((e) => e.includes('unknown limit "vMaxx"')));
	assert.ok(errors.some((e) => e.includes('batteryType 1 already used by a')));
	assert.ok(validateProfilesFile({}).length > 0);
});

test('profile resolved from the batteryType register', () => {
	const active = resolveActiveProfile(sample, { batteryType: 1 });
	assert.equal(active.name, 'liion');
	assert.equal(active.source, 'register');
	assert.equal(active.usable, true);
});

test('manual declaration wins over the register', () => {
	const active = resolveActiveProfile(sample, { batteryType: 1, manualProfile: 'todo' });
	assert.equal(active.name, 'todo');
	assert.equal(active.source, 'manual');
	assert.equal(active.usable, false);
});

test('default deny: unknown battery or unknown profile', () => {
	assert.equal(resolveActiveProfile(sample, { batteryType: 99 }).usable, false);
	assert.equal(resolveActiveProfile(sample, {}).usable, false);
	assert.equal(resolveActiveProfile(sample, { manualProfile: 'nope' }).usable, false);
	assert.equal(resolveActiveProfile(sample, { batteryType: 3 }).usable, false);
});
