import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FACTORS, rawUpdateSql, summaryUpdateSql } from '../tools/migrate-sen55-scale.js';

// Board register map: PM10/PM2.5 x10, VOC/NOx index x1; labsens divided all by 100
test('SEN55 history: factors and statements', () => {
	assert.deepEqual(FACTORS, { pm10: 10, pm2_5: 10, voc: 100, nox: 100 });
	assert.equal(rawUpdateSql('labsens_measurements'), 'UPDATE labsens_measurements SET pm10 = pm10 * 10, pm2_5 = pm2_5 * 10, voc = voc * 100, nox = nox * 100 WHERE id > ? AND id <= ?');
	const summary = summaryUpdateSql('summary_hour');
	assert.match(summary, /^UPDATE summary_hour SET avg_value = avg_value \* \?, min_value = min_value \* \?, max_value = max_value \* \?, p95_value = p95_value \* \?/);
	assert.match(summary, /WHERE source = 'lab' AND metric = \? AND bucket_start < \?$/);
});
