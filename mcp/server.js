// raspi-agent MCP server: the "dashboard for agents" (docs/PIANO-AGENTE.md, 5.5).
// Started by Claude Code over stdio as the raspi-agent user, with agent.env.
// stdout belongs to the MCP protocol: logs go to stderr only.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Bus } from './bus.js';
import { loadAgentConfig, loadEnvConfig } from './config.js';
import { ReadonlyDatabase } from './db.js';
import { NotesStore } from './notes.js';
import { createTools, METRICS, ToolError } from './tools.js';

const log = { log: (...a) => console.error(...a), warn: (...a) => console.error(...a), error: (...a) => console.error(...a) };

const env = loadEnvConfig();
const config = await loadAgentConfig(env.configFile);

const bus = new Bus(env, { log });
bus.connect();
const db = new ReadonlyDatabase(env.mariadb, { maxRows: config.queries.maxRows });
const notes = new NotesStore(env.notesDir, { maxBytes: config.notes.maxBytes });
const tools = createTools({ bus, db, notes, config, batteryTable: env.batteryTable });

const TIME = 'Tempo relativo (-30m, -6h, -7d), "now" o data/ora locale (2026-09-30 14:00)';
const readOnly = { readOnlyHint: true, openWorldHint: false };

const DEFINITIONS = {
	get_live_status: {
		description: 'Valori attuali di laboratorio e batteria, profilo batteria attivo con limiti e commandBounds (limiti effettivi dei comandi), stato dell\'interblocco, eventi aperti. Unità: temperature °C, humidity %, pm µg/m³, voc/nox ppb; batteria mV e mA. ageS = età del dato in secondi.',
		inputSchema: {},
		annotations: readOnly
	},
	get_service_health: {
		description: 'Stato dei servizi systemd (attivo, errori e warning recenti nel journal), di MariaDB, MQTT e del supervisore.',
		inputSchema: {},
		annotations: readOnly
	},
	get_summary: {
		description: `Riassunti aggregati per intervallo: per ogni bucket samples, avg, min, max, p95, maxGapS (buco più lungo nei dati). Metriche lab: ${METRICS.lab.join(', ')}; battery: ${METRICS.battery.join(', ')}. granularity auto sceglie minute/hour/day in base all'intervallo. Da preferire a query_readonly.`,
		inputSchema: {
			from: z.string().optional().describe(`Inizio, default -24h. ${TIME}`),
			to: z.string().optional().describe(`Fine, default now. ${TIME}`),
			granularity: z.enum(['auto', 'minute', 'hour', 'day']).optional(),
			source: z.enum(['lab', 'battery']).optional(),
			metrics: z.array(z.string()).optional().describe('Sottoinsieme di metriche; default tutte quelle della source')
		},
		annotations: readOnly
	},
	get_events: {
		description: 'Eventi del supervisore (soglie, dati fermi, batteria, interblocco, servizi, comandi dell\'agente), dal più recente. Include sempre quelli ancora aperti (resolved = null).',
		inputSchema: {
			since: z.string().optional().describe(`Default -24h. ${TIME}`),
			minSeverity: z.enum(['info', 'warning', 'critical']).optional().describe('Default warning'),
			openOnly: z.boolean().optional(),
			source: z.string().optional().describe('lab, battery, interlock, health, supervisor, agent'),
			limit: z.number().int().min(1).max(config.events.maxLimit).optional(),
			includeDetails: z.boolean().optional().describe('Aggiunge il JSON dei dettagli (più lungo)')
		},
		annotations: readOnly
	},
	get_report_data: {
		description: 'Dati già calcolati per un report sul periodo (ore intere): per ogni grandezza di laboratorio e batteria avg/min/max/p95, copertura dei dati, confronto con il periodo precedente di pari durata, ora del giorno di picco e di minimo, confronto con i valori guida; tempo della batteria in ogni stato con carica stimata; eventi raggruppati per condizione con conteggi e durata; esiti del triage. Una sola chiamata al posto di molte get_summary.',
		inputSchema: {
			from: z.string().optional().describe(`Inizio, default -24h. ${TIME}`),
			to: z.string().optional().describe(`Fine, default now. ${TIME}`)
		},
		annotations: readOnly
	},
	query_readonly: {
		description: `Query SQL di sola lettura su MariaDB (database sensor_data), massimo ${config.queries.maxRows} righe e 10 s. Tabelle: labsens_measurements e battery_measurements (grezze, 1 riga/s: filtrare sempre per recorded_at e aggregare), summary_minute, summary_hour, supervisor_events. Una sola istruzione, niente commenti. Usare solo se get_summary e get_events non bastano.`,
		inputSchema: { sql: z.string().describe('SELECT, WITH, SHOW, DESCRIBE o EXPLAIN') },
		annotations: readOnly
	},
	read_notes: {
		description: 'Le tue note persistenti tra un\'esecuzione e l\'altra. Senza name elenca le note; con name ne restituisce il contenuto.',
		inputSchema: { name: z.string().optional() },
		annotations: readOnly
	},
	write_notes: {
		description: `Scrive una nota persistente (Markdown, max ${config.notes.maxBytes} byte). mode append (default) aggiunge una voce datata; replace riscrive tutto (per riassumere quando la nota cresce).`,
		inputSchema: {
			name: z.string().describe('Minuscole, cifre, - e _ (es. "osservazioni", "batteria")'),
			content: z.string(),
			mode: z.enum(['append', 'replace']).optional()
		},
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
	},
	send_telegram: {
		description: `Invia un messaggio all'utente su Telegram tramite il supervisore (max ${config.telegram.maxChars} caratteri, testo semplice). level indica l'urgenza.`,
		inputSchema: {
			text: z.string(),
			level: z.enum(['info', 'warning', 'critical']).optional()
		},
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
	},
	request_escalation: {
		description: 'Solo durante il triage: chiede un\'indagine approfondita (Sonnet) sugli eventi indicati, quando non bastano i dati o serve un giudizio più accurato. Costa un\'esecuzione del budget giornaliero: usarla solo se necessario.',
		inputSchema: {
			eventIds: z.array(z.number().int()).min(1).max(20),
			summary: z.string().min(10).max(1000).describe('Cosa hai osservato e cosa va chiarito')
		},
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
	},
	send_battery_command: {
		description: 'Comando alla batteria, validato contro il profilo attivo (vedi commandBounds in get_live_status). set_run_state: 0 stop (sempre consentito), 1 carica, 2 scarica; per cambiare modo fermare prima. Setpoint in mA/mV interi positivi. Rifiutato se l\'interblocco è scattato, il profilo non è utilizzabile o i dati non sono aggiornati. Ogni comando, anche rifiutato, viene registrato e notificato all\'utente.',
		inputSchema: {
			command: z.enum(['set_current_ma', 'set_voltage_mv', 'set_run_state']),
			value: z.number().int(),
			reason: z.string().min(3).max(300).describe('Motivazione breve: finisce nell\'audit e nella notifica')
		},
		annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
	}
};

const server = new McpServer({ name: 'raspi', version: '1.0.0' });

for (const [name, definition] of Object.entries(DEFINITIONS)) {
	server.registerTool(name, definition, async (args) => {
		try {
			const result = await tools[name](args ?? {});
			return { content: [{ type: 'text', text: JSON.stringify(result) }] };
		} catch (error) {
			if (!(error instanceof ToolError)) log.error(`[ERROR] ${name}:`, error.stack ?? error.message);
			return { isError: true, content: [{ type: 'text', text: error instanceof ToolError ? error.message : `errore interno: ${error.message}` }] };
		}
	});
}

await server.connect(new StdioServerTransport());

let closing = false;
async function shutdown() {
	if (closing) return;
	closing = true;
	await Promise.allSettled([bus.close(), db.close()]);
	process.exit(0);
}
process.stdin.on('close', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
