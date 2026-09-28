import * as mariadb from 'mariadb';

const SUMMARY_COLUMNS = `
	bucket_start DATETIME NOT NULL,
	source VARCHAR(16) NOT NULL,
	metric VARCHAR(32) NOT NULL,
	samples INT NOT NULL,
	avg_value DOUBLE NULL,
	min_value DOUBLE NULL,
	max_value DOUBLE NULL,
	p95_value DOUBLE NULL,
	max_gap_s DOUBLE NOT NULL,
	PRIMARY KEY (bucket_start, source, metric)`;

export const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS supervisor_events (
		id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
		created_at DATETIME(3) NOT NULL,
		updated_at DATETIME(3) NOT NULL,
		resolved_at DATETIME(3) NULL,
		source VARCHAR(16) NOT NULL,
		type VARCHAR(48) NOT NULL,
		event_key VARCHAR(96) NOT NULL,
		severity ENUM('info', 'warning', 'critical') NOT NULL,
		peak_severity ENUM('info', 'warning', 'critical') NOT NULL,
		message VARCHAR(512) NOT NULL,
		details JSON NULL,
		agent_status VARCHAR(16) NOT NULL DEFAULT 'pending',
		PRIMARY KEY (id),
		INDEX idx_created_at (created_at),
		INDEX idx_open (resolved_at),
		INDEX idx_agent_status (agent_status)
	)`,
	`CREATE TABLE IF NOT EXISTS supervisor_state (
		state_key VARCHAR(64) NOT NULL,
		state_value TEXT NULL,
		updated_at DATETIME(3) NOT NULL,
		PRIMARY KEY (state_key)
	)`,
	`CREATE TABLE IF NOT EXISTS summary_minute (${SUMMARY_COLUMNS})`,
	`CREATE TABLE IF NOT EXISTS summary_hour (${SUMMARY_COLUMNS})`
];

function isConnectionError(error) {
	return Boolean(error?.fatal) || /ECONN|ETIMEDOUT|EHOSTUNREACH|CONNECTION|POOL|socket/i.test(`${error?.code} ${error?.message}`);
}

// Pool with a readiness flag: the supervisor keeps working (rules, interlock,
// Telegram) while MariaDB is down, and the schema is retried until it succeeds.
export class Database {
	constructor(config, { log = console } = {}) {
		this.config = config;
		this.log = log;
		this.ready = false;
		this.pool = mariadb.createPool({
			host: config.host,
			port: config.port,
			user: config.user,
			password: config.password,
			database: config.database,
			connectionLimit: 3,
			acquireTimeout: 5000
		});
		this.retryTimer = null;
	}

	async init() {
		try {
			for (const statement of SCHEMA) {
				await this.pool.query(statement);
			}
			this.ready = true;
			this.log.log('[✓] MariaDB ready');
			return true;
		} catch (error) {
			this.ready = false;
			this.log.error('[ERROR] MariaDB not available:', error.message);
			return false;
		}
	}

	// Keeps trying init() every retrySeconds until it succeeds; onReady runs each time it becomes ready
	start(onReady, retrySeconds = 30) {
		if (onReady) this.onReady = onReady;
		if (this.retryTimer) return Promise.resolve();

		const attempt = async () => {
			this.retryTimer = null;
			if (await this.init()) {
				try {
					await this.onReady?.();
				} catch (error) {
					this.log.error('[ERROR] MariaDB ready handler failed:', error.message);
				}
			} else {
				this.retryTimer = setTimeout(attempt, retrySeconds * 1000);
			}
		};
		return attempt();
	}

	async query(sql, params) {
		try {
			return await this.pool.query(sql, params);
		} catch (error) {
			if (isConnectionError(error) && this.ready) {
				this.ready = false;
				this.log.error('[ERROR] MariaDB connection lost:', error.message);
				this.start();
			}
			throw error;
		}
	}

	async close() {
		clearTimeout(this.retryTimer);
		await this.pool.end();
	}
}

// Writes events in order through a queue: while the database is down the
// operations wait (up to maxQueue) and are replayed when it comes back.
export class EventStore {
	constructor(db, { log = console, maxQueue = 1000, retrySeconds = 10 } = {}) {
		this.db = db;
		this.log = log;
		this.maxQueue = maxQueue;
		this.retrySeconds = retrySeconds;
		this.queue = [];
		this.running = false;
		this.retryTimer = null;
	}

	enqueue(operation) {
		this.queue.push(operation);
		if (this.queue.length > this.maxQueue) {
			this.queue.shift();
			this.log.warn('[WARN] Event queue full, oldest operation dropped');
		}
		this.pump();
	}

	async pump() {
		if (this.running) return;
		this.running = true;
		try {
			while (this.queue.length > 0) {
				if (!this.db.ready) {
					this.scheduleRetry();
					return;
				}
				try {
					await this.queue[0]();
					this.queue.shift();
				} catch (error) {
					if (isConnectionError(error)) {
						this.scheduleRetry();
						return;
					}
					this.log.error('[ERROR] Event write failed, dropped:', error.message);
					this.queue.shift();
				}
			}
		} finally {
			this.running = false;
		}
	}

	scheduleRetry() {
		if (this.retryTimer) return;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			this.pump();
		}, this.retrySeconds * 1000);
		this.retryTimer.unref?.();
	}

	insert(event) {
		this.enqueue(async () => {
			const result = await this.db.query(
				`INSERT INTO supervisor_events
				(created_at, updated_at, resolved_at, source, type, event_key, severity, peak_severity, message, details, agent_status)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					new Date(event.openedAt),
					new Date(event.openedAt),
					event.resolvedAt ? new Date(event.resolvedAt) : null,
					event.source,
					event.type,
					event.key,
					event.severity,
					event.peakSeverity,
					event.message.slice(0, 512),
					JSON.stringify(event.details ?? {}),
					event.severity === 'info' ? 'skip' : 'pending'
				]
			);
			event.dbId = Number(result.insertId);
		});
	}

	update(event, now) {
		this.enqueue(async () => {
			if (!event.dbId) return;
			await this.db.query(
				'UPDATE supervisor_events SET updated_at = ?, severity = ?, peak_severity = ?, message = ?, details = ?, agent_status = IF(agent_status = \'skip\' AND ? <> \'info\', \'pending\', agent_status) WHERE id = ?',
				[new Date(now), event.severity, event.peakSeverity, event.message.slice(0, 512), JSON.stringify(event.details ?? {}), event.severity, event.dbId]
			);
		});
	}

	resolve(event) {
		this.enqueue(async () => {
			if (!event.dbId) return;
			await this.db.query(
				'UPDATE supervisor_events SET updated_at = ?, resolved_at = ?, message = ?, details = ? WHERE id = ?',
				[new Date(event.resolvedAt), new Date(event.resolvedAt), event.message.slice(0, 512), JSON.stringify(event.details ?? {}), event.dbId]
			);
		});
	}

	// Events left open by a previous run: their conditions are re-evaluated from scratch
	closeOrphans(now) {
		this.enqueue(async () => {
			await this.db.query(
				`UPDATE supervisor_events
				SET resolved_at = ?, updated_at = ?, details = JSON_SET(COALESCE(details, '{}'), '$.closedBy', 'supervisor restart')
				WHERE resolved_at IS NULL`,
				[new Date(now), new Date(now)]
			);
		});
	}
}

// Small persistent key/value store (JSON values) with an in-memory cache
export class StateStore {
	constructor(db, { log = console } = {}) {
		this.db = db;
		this.log = log;
		this.cache = new Map();
	}

	async load() {
		const rows = await this.db.query('SELECT state_key, state_value FROM supervisor_state');
		for (const row of rows) {
			// Values set while the database was unreachable are newer: keep them
			if (this.cache.has(row.state_key)) continue;
			try {
				this.cache.set(row.state_key, JSON.parse(row.state_value));
			} catch {
				this.log.warn(`[WARN] Invalid state value for ${row.state_key}, ignored`);
			}
		}
	}

	get(key, fallback = null) {
		return this.cache.has(key) ? this.cache.get(key) : fallback;
	}

	async set(key, value) {
		this.cache.set(key, value);
		if (!this.db.ready) return;
		try {
			await this.db.query(
				'INSERT INTO supervisor_state (state_key, state_value, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE state_value = VALUES(state_value), updated_at = VALUES(updated_at)',
				[key, JSON.stringify(value), new Date()]
			);
		} catch (error) {
			this.log.error(`[ERROR] Could not save state ${key}:`, error.message);
		}
	}

	// Writes the whole cache: used when the database comes back after being down
	async flush() {
		for (const [key, value] of this.cache) {
			await this.set(key, value);
		}
	}
}
