import { SEVERITY_RANK } from './rules.js';

const MAX_MESSAGE_LENGTH = 4000;

// Minimal Telegram Bot API client (native fetch, long polling).
// Only messages from the authorized chat are handed to onCommand.
export class TelegramBot {
	constructor({ token, chatId, fetchImpl = globalThis.fetch, log = console }) {
		this.token = token;
		this.chatId = chatId ? String(chatId) : null;
		this.fetch = fetchImpl;
		this.log = log;
		this.offset = 0;
		this.polling = false;
		this.pollAbort = null;
	}

	get enabled() {
		return Boolean(this.token);
	}

	async call(method, body, timeoutMs = 15000) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		if (method === 'getUpdates') this.pollAbort = controller;
		try {
			const response = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body ?? {}),
				signal: controller.signal
			});
			const data = await response.json();
			if (!data.ok) {
				throw new Error(`Telegram ${method}: ${data.error_code} ${data.description}`);
			}
			return data.result;
		} finally {
			clearTimeout(timer);
		}
	}

	async send(text, chatId = this.chatId) {
		if (!this.enabled || !chatId) return false;
		const body = text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH)}\n…` : text;
		try {
			await this.call('sendMessage', { chat_id: chatId, text: body, disable_web_page_preview: true });
			return true;
		} catch (error) {
			this.log.error('[ERROR] Telegram send failed:', error.message);
			return false;
		}
	}

	async setCommands(commands) {
		if (!this.enabled) return;
		try {
			await this.call('setMyCommands', { commands });
		} catch (error) {
			this.log.warn('[WARN] Telegram setMyCommands failed:', error.message);
		}
	}

	async handleUpdate(update, onCommand) {
		const message = update.message;
		if (!message?.text) return;

		const from = String(message.chat.id);
		if (!this.chatId) {
			this.log.log(`[TELEGRAM] Message from chat ${from}: TELEGRAM_CHAT_ID not configured`);
			await this.send(`Il tuo chat_id è ${from}. Impostalo in TELEGRAM_CHAT_ID nel file .env e riavvia il supervisore.`, from);
			return;
		}
		if (from !== this.chatId) {
			this.log.warn(`[WARN] Telegram message from unauthorized chat ${from} ignored`);
			return;
		}
		if (!message.text.startsWith('/')) {
			await this.send('Usa /help per l\'elenco dei comandi.');
			return;
		}

		const [head, ...args] = message.text.trim().split(/\s+/);
		const command = head.slice(1).split('@')[0].toLowerCase();
		let reply;
		try {
			reply = await onCommand(command, args);
		} catch (error) {
			this.log.error(`[ERROR] Telegram command /${command} failed:`, error.message);
			reply = `Errore nell'esecuzione di /${command}: ${error.message}`;
		}
		if (reply) await this.send(reply);
	}

	async startPolling(onCommand) {
		if (!this.enabled) return;
		this.polling = true;
		let backoffMs = 5000;

		while (this.polling) {
			try {
				const updates = await this.call('getUpdates', { timeout: 30, offset: this.offset, allowed_updates: ['message'] }, 40000);
				backoffMs = 5000;
				for (const update of updates) {
					this.offset = update.update_id + 1;
					await this.handleUpdate(update, onCommand);
				}
			} catch (error) {
				if (!this.polling) break;
				this.log.error('[ERROR] Telegram polling failed:', error.message);
				await new Promise((resolve) => setTimeout(resolve, backoffMs));
				backoffMs = Math.min(backoffMs * 2, 60000);
			}
		}
	}

	stop() {
		this.polling = false;
		this.pollAbort?.abort();
	}
}

const ICONS = { info: 'ℹ️', warning: '⚠️', critical: '🚨' };

export function formatNotification(event, kind) {
	if (kind === 'resolved') {
		return `✅ Rientrato: ${event.message}`;
	}
	const prefix = kind === 'escalated' ? '🔺 ' : '';
	return `${prefix}${ICONS[event.severity] ?? ''} ${event.message}`;
}

// Decides what reaches Telegram: minimum severity, resolved events, and at most
// maxMessagesPerMinute messages (critical ones always go through).
export class Notifier {
	constructor({ bot, config, log = console, now = () => Date.now() }) {
		this.bot = bot;
		this.config = config;
		this.log = log;
		this.now = now;
		this.sentAt = [];
		this.suppressed = 0;
		this.suppressedSince = null;
	}

	shouldNotify(event, kind) {
		const min = SEVERITY_RANK[this.config.notifyMinSeverity];
		if (kind === 'resolved') {
			return this.config.notifyResolved && SEVERITY_RANK[event.peakSeverity ?? event.severity] >= min;
		}
		return SEVERITY_RANK[event.severity] >= min;
	}

	notify(event, kind) {
		const text = formatNotification(event, kind);
		this.log.log(`[EVENT] ${kind} ${event.key}: ${event.message}`);
		if (!this.shouldNotify(event, kind)) return;

		const now = this.now();
		this.sentAt = this.sentAt.filter((t) => t > now - 60000);
		if (event.severity !== 'critical' && this.sentAt.length >= this.config.maxMessagesPerMinute) {
			this.suppressed++;
			this.suppressedSince ??= now;
			return;
		}

		this.sentAt.push(now);
		this.bot.send(text);
	}

	// Called periodically: reports how many notifications were held back
	tick() {
		const now = this.now();
		if (this.suppressed === 0 || now - this.suppressedSince < 60000) return;
		this.bot.send(`… altre ${this.suppressed} notifiche non inviate per limite di frequenza. Usa /eventi per l'elenco.`);
		this.suppressed = 0;
		this.suppressedSince = null;
	}
}
