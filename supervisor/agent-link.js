// Messages from the agent's MCP server (supervisor/agent/<kind>). The supervisor
// is the only one holding the Telegram token: the agent's messages and the audit
// of its battery commands reach the user through here.

const LEVEL_ICONS = { info: '', warning: '⚠️ ', critical: '🚨 ' };
const MAX_TEXT = 3500;

export function formatAudit(record) {
	const what = `${record.command} = ${record.value}`;
	const reason = record.reason ? `\nMotivo: ${record.reason}` : '';
	switch (record.outcome) {
		case 'ok':
			return `🤖 Comando dell'agente eseguito: ${what}${reason}`;
		case 'rejected':
			return `🤖 Comando dell'agente rifiutato: ${what}\n${record.message}${reason}`;
		default:
			return `🤖 ⚠️ Comando dell'agente non riuscito: ${what}\n${record.message ?? record.outcome}${reason}`;
	}
}

export class AgentLink {
	constructor({ bot, events, config, log = console, now = () => Date.now() }) {
		this.bot = bot;
		this.events = events;
		this.maxPerHour = config.agentMaxMessagesPerHour;
		this.log = log;
		this.now = now;
		this.sentAt = [];
		this.limitNoticeAt = 0;
	}

	handle(kind, payload) {
		if (kind === 'telegram') this.onTelegram(payload);
		else if (kind === 'audit') this.onAudit(payload);
	}

	onTelegram({ text, level }) {
		if (typeof text !== 'string' || text.trim() === '') return;
		const now = this.now();
		this.sentAt = this.sentAt.filter((t) => t > now - 3600000);
		if (this.sentAt.length >= this.maxPerHour) {
			this.log.warn('[WARN] Agent message dropped: hourly limit reached');
			if (now - this.limitNoticeAt > 3600000) {
				this.limitNoticeAt = now;
				this.bot.send(`🤖 L'agente ha superato ${this.maxPerHour} messaggi in un'ora: i successivi non vengono inviati.`);
			}
			return;
		}
		this.sentAt.push(now);
		this.log.log(`[AGENT] Telegram (${level ?? 'info'}): ${text.slice(0, 120)}`);
		this.bot.send(`🤖 ${LEVEL_ICONS[level] ?? ''}${text.trim().slice(0, MAX_TEXT)}`);
	}

	onAudit(record) {
		if (!record || typeof record.command !== 'string') return;
		const text = formatAudit(record);
		this.log.log(`[AGENT] ${record.outcome} ${record.command}=${record.value}: ${record.message ?? ''}`);
		// Recorded as info (the agent does not triage its own commands) and always sent
		this.events.record({
			key: 'agent:command',
			source: 'agent',
			type: record.outcome === 'rejected' ? 'command_rejected' : 'command',
			severity: 'info',
			message: text.replace(/^🤖 (⚠️ )?/, '').replace(/\n/g, ' — ').slice(0, 500),
			details: record
		}, this.now());
		this.bot.send(text);
	}
}
