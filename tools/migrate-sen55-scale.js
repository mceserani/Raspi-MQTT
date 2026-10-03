// Fixes the SEN55 history: until 2026-10-03 labsens-mqtt.js divided every
// register by 100, while the board stores PM10/PM2.5 x10 and the VOC/NOx
// indices x1 (Registri schede.xlsx). Stored PM are 10 times too low, VOC/NOx
// 100 times: this multiplies the raw rows and the lab summaries.
//
// Run it ONCE, with labsens-mqtt.js and the supervisor stopped, BEFORE starting
// the new labsens-mqtt.js (its rows are already right):
//   sudo systemctl stop raspi-supervisor raspi-labsens
//   node --env-file=.env tools/migrate-sen55-scale.js          (counts only)
//   node --env-file=.env tools/migrate-sen55-scale.js --yes    (migrates)
//   sudo systemctl start raspi-labsens raspi-supervisor
//
// Resumable and never applied twice: the progress is saved in supervisor_state
// (migration.sen55_scale) after every batch.
import * as mariadb from 'mariadb';

export const FACTORS = { pm10: 10, pm2_5: 10, voc: 100, nox: 100 };
const STATE_KEY = 'migration.sen55_scale';
const BATCH_ROWS = 20000;
// A row younger than this means labsens-mqtt.js is still writing
const MIN_IDLE_SECONDS = 30;

export function rawUpdateSql(table) {
	const set = Object.entries(FACTORS).map(([column, factor]) => `${column} = ${column} * ${factor}`).join(', ');
	return `UPDATE ${table} SET ${set} WHERE id > ? AND id <= ?`;
}

export function summaryUpdateSql(table) {
	return `UPDATE ${table} SET avg_value = avg_value * ?, min_value = min_value * ?, max_value = max_value * ?, p95_value = p95_value * ?
		WHERE source = 'lab' AND metric = ? AND bucket_start < ?`;
}

async function main() {
	const apply = process.argv.includes('--yes');
	const table = process.env.LABSENS_DB_TABLE ?? 'labsens_measurements';
	if (!/^\w+$/.test(table)) throw new Error(`Nome di tabella non valido: ${table}`);

	const pool = mariadb.createPool({
		host: process.env.MARIADB_HOST ?? 'localhost',
		port: Number(process.env.MARIADB_PORT ?? 3306),
		user: process.env.MARIADB_USER ?? 'mceserani',
		password: process.env.MARIADB_PASSWORD,
		database: process.env.MARIADB_DATABASE ?? 'sensor_data',
		connectionLimit: 1
	});
	const loadState = async () => {
		const [row] = await pool.query('SELECT state_value FROM supervisor_state WHERE state_key = ?', [STATE_KEY]);
		return row ? JSON.parse(row.state_value) : null;
	};
	const saveState = (value) => pool.query(
		'INSERT INTO supervisor_state (state_key, state_value, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE state_value = VALUES(state_value), updated_at = VALUES(updated_at)',
		[STATE_KEY, JSON.stringify(value), new Date()]
	);

	try {
		let state = await loadState();
		if (state?.done) {
			console.log(`Migrazione già completata il ${state.doneAt}: niente da fare.`);
			return;
		}

		if (!state) {
			const [last] = await pool.query(`SELECT MAX(id) AS id, MAX(recorded_at) AS at, COUNT(*) AS n FROM ${table}`);
			const idleSeconds = last.at ? (Date.now() - new Date(last.at).getTime()) / 1000 : Infinity;
			if (idleSeconds < MIN_IDLE_SECONDS) {
				throw new Error(`l'ultima riga di ${table} ha ${Math.round(idleSeconds)} s: labsens-mqtt.js sta ancora scrivendo. Fermalo (sudo systemctl stop raspi-supervisor raspi-labsens) e riprova.`);
			}
			const [summaries] = await pool.query(
				`SELECT (SELECT COUNT(*) FROM summary_minute WHERE source = 'lab' AND metric IN (?)) AS minute,
					(SELECT COUNT(*) FROM summary_hour WHERE source = 'lab' AND metric IN (?)) AS hour`,
				[Object.keys(FACTORS), Object.keys(FACTORS)]
			);
			console.log(`Righe grezze da correggere: ${Number(last.n)} (id fino a ${last.id}, ultima ${new Date(last.at).toLocaleString('it-IT')})`);
			console.log(`Riassunti del laboratorio da correggere: ${Number(summaries.minute)} al minuto, ${Number(summaries.hour)} orari`);
			console.log(`Fattori: ${Object.entries(FACTORS).map(([c, f]) => `${c} ×${f}`).join(', ')}`);
			if (!apply) {
				console.log('\nProva: nulla è stato modificato. Per applicare: aggiungi --yes (labsens e supervisore fermi).');
				return;
			}
			// From here on, rows up to maxId and summaries before cutoff are the old ones
			state = { maxId: Number(last.id ?? 0), doneUpTo: 0, cutoff: new Date().toISOString(), summariesDone: false, startedAt: new Date().toISOString() };
			await saveState(state);
		} else if (!apply) {
			console.log(`Migrazione interrotta a id ${state.doneUpTo} di ${state.maxId}: rilancia con --yes per riprendere.`);
			return;
		}

		if (!state.summariesDone) {
			for (const summaryTable of ['summary_minute', 'summary_hour']) {
				for (const [metric, factor] of Object.entries(FACTORS)) {
					const result = await pool.query(summaryUpdateSql(summaryTable), [factor, factor, factor, factor, metric, new Date(state.cutoff)]);
					console.log(`${summaryTable} ${metric}: ${result.affectedRows} righe`);
				}
			}
			state.summariesDone = true;
			await saveState(state);
		}

		const started = Date.now();
		const startedFrom = state.doneUpTo;
		while (state.doneUpTo < state.maxId) {
			const to = Math.min(state.doneUpTo + BATCH_ROWS, state.maxId);
			await pool.query(rawUpdateSql(table), [state.doneUpTo, to]);
			state.doneUpTo = to;
			await saveState(state);
			const rate = (to - startedFrom) / Math.max(1, (Date.now() - started) / 1000);
			const eta = Math.round((state.maxId - to) / Math.max(rate, 1) / 60);
			process.stdout.write(`\rRighe grezze: id ${to} di ${state.maxId} (${Math.round((to / Math.max(state.maxId, 1)) * 100)} %, circa ${eta} min alla fine)   `);
		}

		state.done = true;
		state.doneAt = new Date().toISOString();
		await saveState(state);
		console.log('\nMigrazione completata. Ora: sudo systemctl start raspi-labsens raspi-supervisor');
	} finally {
		await pool.end();
	}
}

if (process.argv[1]?.endsWith('migrate-sen55-scale.js')) {
	main().catch((error) => {
		console.error(`\nErrore: ${error.message}`);
		process.exit(1);
	});
}
