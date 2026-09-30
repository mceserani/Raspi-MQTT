// Pure helpers of the MCP server: read-only SQL guard, time parsing and a
// compact representation of rows (fewer tokens for the agent).

const READONLY_START = /^(select|with|show|describe|desc|explain)\b/i;
const FORBIDDEN = /\b(into\s+(outfile|dumpfile|@)|for\s+update|lock\s+in\s+share\s+mode|load_file|sleep|benchmark|get_lock)\b/i;

// The MariaDB user is read-only anyway: this refuses what it would still allow
// (several statements, file access, locks, deliberate waits).
export function checkReadonlySql(sql) {
	if (typeof sql !== 'string' || sql.trim() === '') {
		return { ok: false, reason: 'query vuota' };
	}
	const text = sql.trim().replace(/;\s*$/, '');
	if (text.includes(';')) {
		return { ok: false, reason: 'una sola istruzione per volta, senza ";" interni' };
	}
	if (/--|#|\/\*/.test(text)) {
		return { ok: false, reason: 'commenti non ammessi nella query' };
	}
	if (!READONLY_START.test(text)) {
		return { ok: false, reason: 'solo SELECT, WITH, SHOW, DESCRIBE o EXPLAIN' };
	}
	if (FORBIDDEN.test(text)) {
		return { ok: false, reason: 'costrutto non ammesso (INTO OUTFILE/variabili, FOR UPDATE, LOCK, LOAD_FILE, SLEEP, BENCHMARK, GET_LOCK)' };
	}
	return { ok: true, sql: text };
}

const RELATIVE = /^-(\d+(?:\.\d+)?)\s*(m|min|h|d|g)$/i;
const UNIT_MS = { m: 60000, min: 60000, h: 3600000, d: 86400000, g: 86400000 };

// Accepts "now", relative times like "-30m", "-6h", "-7d", or a date/time
// (without a zone it is local time, as in the database).
export function parseTime(input, now) {
	if (input === undefined || input === null || input === '' || input === 'now') {
		return now;
	}
	const text = String(input).trim();
	const relative = text.match(RELATIVE);
	if (relative) {
		return now - Number(relative[1]) * UNIT_MS[relative[2].toLowerCase()];
	}
	const ms = new Date(text.replace(' ', 'T')).getTime();
	if (Number.isNaN(ms)) {
		throw new Error(`tempo non valido: "${input}" (usa -30m, -6h, -7d oppure 2026-09-30 14:00)`);
	}
	return ms;
}

const pad = (n) => String(n).padStart(2, '0');

// Local time, as stored in the database and as the user reads it
export function formatLocal(value, { seconds = true } = {}) {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return null;
	const base = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
	return seconds ? `${base}:${pad(date.getSeconds())}` : base;
}

export function roundValue(value, digits = 2) {
	if (typeof value !== 'number' || !Number.isFinite(value)) return value;
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

// Converts one database value to something small and JSON-friendly
export function toPlain(value, maxCellChars) {
	if (value === null || value === undefined) return null;
	if (typeof value === 'bigint') {
		return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
	}
	if (value instanceof Date) return formatLocal(value);
	if (Buffer.isBuffer(value)) return `<${value.length} byte binari>`;
	if (typeof value === 'number') return roundValue(value, 4);
	if (typeof value === 'object') value = JSON.stringify(value);
	if (typeof value === 'string' && value.length > maxCellChars) {
		return `${value.slice(0, maxCellChars)}…`;
	}
	return value;
}

// Rows as { columns, rows: [[...]] }, capped in number and total size
export function compactRows(rows, { maxRows, maxCellChars, maxResultChars }) {
	const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
	const out = [];
	let size = 0;
	let truncated = rows.length > maxRows;

	for (const row of rows.slice(0, maxRows)) {
		const values = columns.map((column) => toPlain(row[column], maxCellChars));
		size += JSON.stringify(values).length;
		if (size > maxResultChars) {
			truncated = true;
			break;
		}
		out.push(values);
	}

	return { columns, rows: out, rowCount: out.length, truncated };
}
