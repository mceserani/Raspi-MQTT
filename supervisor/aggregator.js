import { decodeLabValue, LAB_METRICS } from './decode.js';
import { summarize } from './stats.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

export const GRANULARITIES = [
	{ name: 'minute', table: 'summary_minute', bucketMs: MINUTE_MS, chunkMs: HOUR_MS },
	{ name: 'hour', table: 'summary_hour', bucketMs: HOUR_MS, chunkMs: HOUR_MS }
];

// Start of the local-time bucket containing ms (minutes and hours)
export function floorToBucket(ms, bucketMs) {
	const date = new Date(ms);
	if (bucketMs === HOUR_MS) {
		date.setMinutes(0, 0, 0);
	} else {
		date.setSeconds(0, 0);
	}
	return date.getTime();
}

export function sourcesFor(tables) {
	return [
		{ source: 'lab', table: tables.lab, columns: LAB_METRICS, decode: decodeLabValue },
		{ source: 'battery', table: tables.battery, columns: ['voltage_measured_mv', 'current_measured_ma'], decode: (_column, value) => value }
	];
}

// Splits the raw rows of [fromMs, toMs) into buckets and summarizes every
// column. Empty buckets are written too (samples = 0): they document the gaps.
export function bucketize(rows, source, fromMs, toMs, bucketMs) {
	const buckets = new Map();
	for (let start = fromMs; start < toMs; start += bucketMs) {
		buckets.set(start, []);
	}

	for (const row of rows) {
		const t = new Date(row.recorded_at).getTime();
		const start = fromMs + Math.floor((t - fromMs) / bucketMs) * bucketMs;
		buckets.get(start)?.push(row);
	}

	const summaries = [];
	for (const [start, bucketRows] of buckets) {
		for (const column of source.columns) {
			const samples = bucketRows.map((row) => ({
				t: new Date(row.recorded_at).getTime(),
				v: row[column] === null || row[column] === undefined ? null : source.decode(column, Number(row[column]))
			}));
			summaries.push({ bucketStart: start, source: source.source, metric: column, ...summarize(samples, start, start + bucketMs) });
		}
	}
	return summaries;
}

export class Aggregator {
	constructor({ db, state, config, tables, log = console, now = () => Date.now() }) {
		for (const table of Object.values(tables)) {
			if (!/^\w+$/.test(table)) throw new Error(`Invalid table name: ${table}`);
		}
		this.db = db;
		this.state = state;
		this.config = config;
		this.sources = sourcesFor(tables);
		this.log = log;
		this.now = now;
		this.running = false;
		this.maxChunksPerRun = 24;
	}

	async run() {
		if (this.running || !this.db.ready) return;
		this.running = true;
		try {
			for (const granularity of GRANULARITIES) {
				await this.process(granularity);
			}
		} catch (error) {
			this.log.error('[ERROR] Aggregation failed:', error.message);
		} finally {
			this.running = false;
		}
	}

	async process(granularity) {
		const cursorKey = `aggregation.${granularity.name}.cursor`;
		const now = this.now();
		let cursor = this.state.get(cursorKey) ?? floorToBucket(now - this.config.backfillHours * HOUR_MS, granularity.bucketMs);
		const lastCompleteEnd = floorToBucket(now - this.config.lagSeconds * 1000, granularity.bucketMs);

		for (let chunk = 0; chunk < this.maxChunksPerRun && cursor < lastCompleteEnd; chunk++) {
			const chunkEnd = Math.min(cursor + granularity.chunkMs, lastCompleteEnd);
			const summaries = [];

			for (const source of this.sources) {
				const rows = await this.db.query(
					`SELECT recorded_at, ${source.columns.join(', ')} FROM ${source.table}
					WHERE recorded_at >= ? AND recorded_at < ? ORDER BY recorded_at`,
					[new Date(cursor), new Date(chunkEnd)]
				);
				summaries.push(...bucketize(rows, source, cursor, chunkEnd, granularity.bucketMs));
			}

			await this.write(granularity.table, summaries);
			cursor = chunkEnd;
			await this.state.set(cursorKey, cursor);
		}
	}

	async write(table, summaries) {
		const batchSize = 500;
		for (let i = 0; i < summaries.length; i += batchSize) {
			const batch = summaries.slice(i, i + batchSize);
			const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
			const params = batch.flatMap((s) => [new Date(s.bucketStart), s.source, s.metric, s.samples, s.avg, s.min, s.max, s.p95, s.maxGapS]);
			await this.db.query(
				`INSERT INTO ${table} (bucket_start, source, metric, samples, avg_value, min_value, max_value, p95_value, max_gap_s)
				VALUES ${placeholders}
				ON DUPLICATE KEY UPDATE samples = VALUES(samples), avg_value = VALUES(avg_value), min_value = VALUES(min_value),
					max_value = VALUES(max_value), p95_value = VALUES(p95_value), max_gap_s = VALUES(max_gap_s)`,
				params
			);
		}
	}
}
