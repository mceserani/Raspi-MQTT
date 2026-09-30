import * as mariadb from 'mariadb';

// Read-only access with the agent_ro user. Every query runs in a read-only
// session with a row cap on top-level SELECTs (sql_select_limit) and a time
// limit, so a careless query cannot load the Pi or the MCP process.
export class ReadonlyDatabase {
	constructor(config, { maxRows, maxStatementSeconds = 10 }) {
		this.maxRows = maxRows;
		this.maxStatementSeconds = maxStatementSeconds;
		this.pool = mariadb.createPool({
			host: config.host,
			port: config.port,
			user: config.user,
			password: config.password,
			database: config.database,
			connectionLimit: 2,
			acquireTimeout: 5000,
			connectTimeout: 5000
		});
	}

	// rowLimit: rows fetched at most (one more than shown, to detect truncation)
	async query(sql, params = [], { rowLimit = this.maxRows + 1 } = {}) {
		const connection = await this.pool.getConnection();
		try {
			await connection.query('SET SESSION TRANSACTION READ ONLY');
			await connection.query(`SET SESSION sql_select_limit = ${Number(rowLimit)}, max_statement_time = ${Number(this.maxStatementSeconds)}`);
			return await connection.query(sql, params);
		} finally {
			await connection.release();
		}
	}

	async close() {
		await this.pool.end();
	}
}
