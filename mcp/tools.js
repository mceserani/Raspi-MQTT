import { buildCyclesResult } from './cycles.js';
import { checkReadonlySql, compactRows, formatLocal, parseTime, roundValue } from './format.js';
import { buildReportData, floorToHour } from './report.js';
import { AGENT_COMMANDS, commandBounds, statusAgeSeconds, validateBatteryCommand } from './validation.js';

// Tool implementations of the MCP server, independent of the MCP transport
// (server.js registers them). Results are small JSON objects; a thrown
// ToolError becomes an error result the agent can read and act on.

export class ToolError extends Error {}

export const METRICS = {
	lab: ['temperature', 'humidity', 'co2', 'pm2_5', 'pm10', 'voc', 'nox', 'ntc_temperature'],
	battery: ['voltage_measured_mv', 'current_measured_ma']
};

const RUN_STATES = { 0: 'ferma', 1: 'carica', 2: 'scarica' };
const SEVERITIES = ['info', 'warning', 'critical'];
const GRANULARITY_MS = { minute: 60000, hour: 3600000, day: 86400000 };

function procedureView(p) {
	return {
		id: p.id,
		name: p.name,
		step: `${p.step}/${p.steps}`,
		current: p.current,
		stepSince: p.stepStartedAt ? formatLocal(p.stepStartedAt, { seconds: false }) : null,
		startedAt: formatLocal(p.startedAt, { seconds: false }),
		maxHours: roundValue(p.maxMinutes / 60, 1)
	};
}

function parseJson(value) {
	if (value === null || value === undefined || typeof value === 'object') return value ?? null;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

const localOrNull = (ms) => (ms ? formatLocal(ms, { seconds: false }) : null);

function procedureRow(row) {
	const steps = parseJson(row.steps) ?? [];
	return {
		id: row.procedure_id,
		name: row.name,
		status: row.status,
		startedAt: localOrNull(row.started_at),
		endedAt: localOrNull(row.ended_at),
		requestedBy: row.requested_by,
		reason: row.reason,
		profile: row.profile,
		spec: parseJson(row.spec),
		results: Array.isArray(steps) ? steps.map((s) => ({ ...s, startedAt: localOrNull(s.startedAt), endedAt: localOrNull(s.endedAt) })) : steps,
		endMessage: row.end_message
	};
}

export function createTools({ bus, db, notes, config, batteryTable = 'battery_measurements', now = () => Date.now() }) {
	if (!/^\w+$/.test(batteryTable)) throw new Error(`Invalid table name: ${batteryTable}`);
	const commandTimes = [];

	async function currentStatus() {
		const { status } = await bus.getStatus(config.status.waitSeconds);
		return status;
	}

	function requireSupervisor(status) {
		if (!status || status.online === false) {
			throw new ToolError('supervisore non raggiungibile (nessuno stato su MQTT o servizio fermo)');
		}
		const age = statusAgeSeconds(status, now());
		if (age > config.status.maxAgeSeconds) {
			throw new ToolError(`stato del supervisore vecchio di ${Math.round(age)} s: il supervisore potrebbe essere bloccato`);
		}
		return age;
	}

	async function audit(record) {
		try {
			await bus.publishToSupervisor('audit', record);
		} catch {
			// The command result is returned anyway; the missing audit is reported in it
			record.auditFailed = true;
		}
	}

	return {
		async get_live_status() {
			const status = await currentStatus();
			const age = requireSupervisor(status);

			const lab = {};
			for (const [sensor, entry] of Object.entries(status.live?.lab ?? {})) {
				lab[sensor] = { value: roundValue(entry.value, 2), ageS: Math.round(entry.ageSeconds + age), ...(entry.invalid ? { invalid: true } : {}) };
			}

			const b = status.live?.battery;
			const battery = b ? {
				state: RUN_STATES[b.runState] ?? b.runState,
				voltageMv: b.voltageMeasuredMv,
				currentMa: b.currentMeasuredMa,
				setpointVoltageMv: b.voltageSetpointMv,
				setpointCurrentMa: b.currentSetpointMa,
				batteryType: b.batteryType,
				ageS: Math.round(b.ageSeconds + age),
				...(status.batteryPhase ? { phase: { ...status.batteryPhase, since: formatLocal(status.batteryPhase.since, { seconds: false }) } } : {})
			} : null;

			const profile = status.profile ?? {};
			return {
				at: formatLocal(now()),
				lab,
				battery,
				profile: {
					name: profile.name,
					source: profile.source,
					usable: Boolean(profile.usable),
					...(profile.usable ? { limits: profile.limits, commandBounds: commandBounds(profile.limits, config.commands) } : { reasons: profile.reasons })
				},
				interlock: status.interlock?.latched
					? { state: 'scattato', at: formatLocal(status.interlock.latched.at), reasons: status.interlock.latched.reasons }
					: { state: status.interlock?.armed ? 'armato' : 'inattivo' },
				openEvents: (status.openEvents ?? []).map((e) => ({ severity: e.severity, message: e.message, since: formatLocal(e.openedAt, { seconds: false }) })),
				...(status.procedure ? { procedure: procedureView(status.procedure) } : {})
			};
		},

		async get_service_health() {
			const status = await currentStatus();
			const age = requireSupervisor(status);
			const services = {};
			for (const [unit, service] of Object.entries(status.health?.services ?? {})) {
				services[unit] = { state: service.state, errors: service.errors, warnings: service.warnings };
			}
			return {
				supervisor: { online: true, statusAgeS: Math.round(age), uptimeH: roundValue((status.uptimeSeconds ?? 0) / 3600, 1) },
				database: status.databaseReady ? 'ok' : 'non raggiungibile dal supervisore',
				mqtt: bus.connected ? 'ok' : 'non connesso',
				services,
				checkedAt: status.health?.at ? formatLocal(status.health.at) : null
			};
		},

		async get_summary({ from = '-24h', to = 'now', granularity = 'auto', source, metrics }) {
			const t = now();
			const fromMs = parseTime(from, t);
			const toMs = parseTime(to, t);
			if (!(fromMs < toMs)) throw new ToolError('"from" deve precedere "to"');

			const known = source ? METRICS[source] : [...METRICS.lab, ...METRICS.battery];
			if (!known) throw new ToolError(`source non valida: ${source} (lab o battery)`);
			const selected = metrics?.length ? metrics : known;
			const unknown = selected.filter((m) => !known.includes(m));
			if (unknown.length) throw new ToolError(`metriche sconosciute: ${unknown.join(', ')}. Disponibili: ${known.join(', ')}`);

			const maxPoints = config.summary.maxBuckets;
			const pointsFor = (g) => Math.ceil((toMs - fromMs) / GRANULARITY_MS[g]) * selected.length;
			let chosen = granularity;
			if (chosen === 'auto') {
				chosen = ['minute', 'hour', 'day'].find((g) => pointsFor(g) <= maxPoints) ?? 'day';
			}
			if (!GRANULARITY_MS[chosen]) throw new ToolError(`granularity non valida: ${granularity}`);
			if (pointsFor(chosen) > maxPoints) {
				throw new ToolError(`troppi punti (${pointsFor(chosen)} > ${maxPoints}): riduci l'intervallo o le metriche, oppure usa una granularità più ampia`);
			}

			const filters = ['bucket_start >= ?', 'bucket_start < ?', `metric IN (${selected.map(() => '?').join(', ')})`];
			const params = [new Date(fromMs), new Date(toMs), ...selected];
			if (source) {
				filters.push('source = ?');
				params.push(source);
			}
			const where = filters.join(' AND ');

			// Days come from the hourly table: sample-weighted mean, p95 = worst hourly p95
			const sql = chosen === 'day'
				? `SELECT DATE(bucket_start) AS bucket, source, metric, SUM(samples) AS samples,
						SUM(avg_value * samples) / NULLIF(SUM(samples), 0) AS avg_value, MIN(min_value) AS min_value,
						MAX(max_value) AS max_value, MAX(p95_value) AS p95_value, MAX(max_gap_s) AS max_gap_s
					FROM summary_hour WHERE ${where} GROUP BY DATE(bucket_start), source, metric ORDER BY source, metric, bucket`
				: `SELECT bucket_start AS bucket, source, metric, samples, avg_value, min_value, max_value, p95_value, max_gap_s
					FROM summary_${chosen} WHERE ${where} ORDER BY source, metric, bucket`;

			const rows = await db.query(sql, params, { rowLimit: maxPoints + 1 });
			const series = {};
			for (const row of rows) {
				const key = `${row.source}.${row.metric}`;
				const bucket = chosen === 'day' ? formatLocal(row.bucket).slice(0, 10) : formatLocal(row.bucket, { seconds: false });
				(series[key] ??= []).push([bucket, Number(row.samples), roundValue(row.avg_value), roundValue(row.min_value), roundValue(row.max_value), roundValue(row.p95_value), roundValue(row.max_gap_s, 0)]);
			}

			return {
				granularity: chosen,
				from: formatLocal(fromMs, { seconds: false }),
				to: formatLocal(toMs, { seconds: false }),
				columns: ['bucket', 'samples', 'avg', 'min', 'max', 'p95', 'maxGapS'],
				series,
				...(rows.length === 0 ? { note: 'nessun riassunto nell\'intervallo: le aggregazioni partono dall\'avvio del supervisore (backfill 24 h)' } : {})
			};
		},

		async get_events({ since = '-24h', minSeverity = 'warning', openOnly = false, source, limit, includeDetails = false }) {
			const sinceMs = parseTime(since, now());
			const rank = SEVERITIES.indexOf(minSeverity);
			if (rank < 0) throw new ToolError(`minSeverity non valida: ${minSeverity}`);
			const max = Math.min(limit ?? config.events.defaultLimit, config.events.maxLimit);

			const filters = [openOnly ? 'resolved_at IS NULL' : '(created_at >= ? OR resolved_at IS NULL)', `peak_severity IN (${SEVERITIES.slice(rank).map(() => '?').join(', ')})`];
			const params = openOnly ? [] : [new Date(sinceMs)];
			params.push(...SEVERITIES.slice(rank));
			if (source) {
				filters.push('source = ?');
				params.push(source);
			}

			const rows = await db.query(
				`SELECT id, created_at AS opened, resolved_at AS resolved, source, type, severity, peak_severity AS peak, message, agent_status${includeDetails ? ', details' : ''}
				FROM supervisor_events WHERE ${filters.join(' AND ')} ORDER BY created_at DESC LIMIT ${Number(max)}`,
				params,
				{ rowLimit: max }
			);
			return compactRows(rows, { ...config.queries, maxRows: max });
		},

		async get_report_data({ from = '-24h', to = 'now' }) {
			const t = now();
			// Whole hours: the report is built on the hourly summaries
			const fromMs = floorToHour(parseTime(from, t));
			const toMs = floorToHour(parseTime(to, t));
			if (!(fromMs < toMs)) throw new ToolError('serve almeno un\'ora intera tra "from" e "to"');
			const maxDays = config.reports?.maxDays ?? 31;
			if (toMs - fromMs > maxDays * 86400000) throw new ToolError(`intervallo troppo lungo (massimo ${maxDays} giorni)`);
			try {
				return await buildReportData({
					db,
					fromMs,
					toMs,
					references: config.reports?.references ?? {},
					batteryTable,
					maxGroups: config.reports?.maxEventGroups ?? 15
				});
			} catch (error) {
				throw new ToolError(`errore MariaDB: ${error.sqlMessage ?? error.message}`);
			}
		},

		async get_battery_cycles({ since = config.cycles?.defaultSince ?? '-30d', limit }) {
			const sinceMs = parseTime(since, now());
			const maxPhases = config.cycles?.maxPhases ?? 100;
			const max = Math.min(limit ?? maxPhases, maxPhases);
			try {
				const rows = await db.query(
					`SELECT * FROM battery_phases WHERE started_at >= ? ORDER BY started_at DESC LIMIT ${Number(max) + 1}`,
					[new Date(sinceMs)],
					{ rowLimit: max + 1 }
				);
				const [state] = await db.query("SELECT state_value FROM supervisor_state WHERE state_key = 'cycles'");
				let saved = null;
				try {
					saved = state?.state_value ? JSON.parse(state.state_value) : null;
				} catch {
					// Without the open phase the rest is still valid
				}
				return buildCyclesResult({ rows: rows.slice(0, max), truncated: rows.length > max, saved, now: now(), sinceMs, maxRestHours: config.cycles?.maxRestHours ?? 24 });
			} catch (error) {
				throw new ToolError(`errore MariaDB: ${error.sqlMessage ?? error.message}`);
			}
		},

		async start_procedure({ name, steps, repeat, reason }) {
			const status = await currentStatus();
			requireSupervisor(status);
			const spec = { name, steps, ...(repeat ? { repeat } : {}) };
			const reply = await bus.requestSupervisor('procedure', { action: 'start', spec, reason }, config.procedures?.replyTimeoutSeconds ?? 10);
			if (reply.timeout) throw new ToolError('nessuna risposta dal supervisore: procedura non avviata');
			if (!reply.ok) return { started: false, rejected: reply.reason };
			return {
				started: true,
				id: reply.id,
				steps: reply.steps,
				maxHours: roundValue(reply.maxMinutes / 60, 1),
				note: 'la esegue il supervisore: avvio e fine arrivano all\'utente su Telegram; stato con get_live_status o get_procedures'
			};
		},

		async stop_procedure({ reason }) {
			const status = await currentStatus();
			requireSupervisor(status);
			const reply = await bus.requestSupervisor('procedure', { action: 'stop', reason }, config.procedures?.replyTimeoutSeconds ?? 10);
			if (reply.timeout) throw new ToolError('nessuna risposta dal supervisore: per fermare la batteria usa send_battery_command set_run_state 0');
			return reply.ok ? { stopping: true, id: reply.id, note: 'il supervisore ferma la batteria entro pochi secondi' } : { stopping: false, message: reply.reason };
		},

		async get_procedures({ limit = 5 }) {
			const max = Math.min(Math.max(1, limit), 20);
			try {
				const rows = await db.query(
					`SELECT procedure_id, started_at, ended_at, name, status, requested_by, reason, profile, spec, steps, end_message
					FROM battery_procedures ORDER BY started_at DESC LIMIT ${Number(max)}`,
					[],
					{ rowLimit: max }
				);
				return { procedures: rows.map(procedureRow) };
			} catch (error) {
				throw new ToolError(`errore MariaDB: ${error.sqlMessage ?? error.message}`);
			}
		},

		async query_readonly({ sql }) {
			const check = checkReadonlySql(sql);
			if (!check.ok) throw new ToolError(`query rifiutata: ${check.reason}`);
			try {
				const rows = await db.query(check.sql);
				const list = Array.isArray(rows) ? rows : [rows];
				return compactRows(list, config.queries);
			} catch (error) {
				throw new ToolError(`errore MariaDB: ${error.sqlMessage ?? error.message}`);
			}
		},

		async read_notes({ name }) {
			if (!name) return { notes: await notes.list() };
			const content = await notes.read(name);
			if (content === null) throw new ToolError(`nota "${name}" inesistente`);
			return { name, content };
		},

		async write_notes({ name, content, mode = 'append' }) {
			try {
				return await notes.write(name, content, mode);
			} catch (error) {
				throw new ToolError(error.message);
			}
		},

		async send_telegram({ text, level = 'info' }) {
			const status = await currentStatus();
			requireSupervisor(status);
			const body = text.trim();
			if (!body) throw new ToolError('messaggio vuoto');
			if (body.length > config.telegram.maxChars) {
				throw new ToolError(`messaggio troppo lungo (${body.length} > ${config.telegram.maxChars} caratteri): riassumilo`);
			}
			await bus.publishToSupervisor('telegram', { text: body, level });
			return { delivered: 'consegnato al supervisore per l\'invio' };
		},

		async request_escalation({ eventIds, summary }) {
			const status = await currentStatus();
			requireSupervisor(status);
			if (!summary?.trim()) throw new ToolError('sintesi mancante');
			await bus.publishToSupervisor('escalate', { eventIds, summary: summary.trim() });
			return { requested: 'indagine chiesta al supervisore: partirà con Sonnet se il budget lo consente' };
		},

		async send_battery_command({ command, value, reason }) {
			if (!AGENT_COMMANDS.includes(command)) throw new ToolError(`comando non consentito: ${command}`);
			const t = now();
			while (commandTimes.length && commandTimes[0] < t - 60000) commandTimes.shift();
			const isStop = command === 'set_run_state' && value === 0;
			if (!isStop && commandTimes.length >= config.commands.maxPerMinute) {
				throw new ToolError(`limite di ${config.commands.maxPerMinute} comandi al minuto raggiunto`);
			}

			const status = await currentStatus();
			const check = validateBatteryCommand({ command, value }, { status, now: t, config });
			const record = { command, value, reason, source: 'agent' };
			if (!check.ok) {
				await audit({ ...record, outcome: 'rejected', message: check.reason });
				return { executed: false, rejected: check.reason };
			}

			commandTimes.push(t);
			let result;
			try {
				result = await bus.sendBatteryCommand({ command, value, reason }, config.commands.ackTimeoutSeconds);
			} catch (error) {
				await audit({ ...record, outcome: 'error', message: error.message });
				throw new ToolError(`invio non riuscito: ${error.message}`);
			}

			const outcome = result.timeout ? 'timeout' : result.ack.status === 'ok' ? 'ok' : 'error';
			const message = result.timeout
				? `nessuna conferma entro ${config.commands.ackTimeoutSeconds} s (bridge o servizio batteria fermi?)`
				: result.ack.message;
			const auditRecord = { ...record, commandId: result.commandId, outcome, message };
			await audit(auditRecord);
			return {
				executed: outcome === 'ok',
				outcome,
				message,
				commandId: result.commandId,
				...(auditRecord.auditFailed ? { warning: 'audit non registrato dal supervisore' } : {})
			};
		}
	};
}
