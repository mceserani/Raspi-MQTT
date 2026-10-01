// Scheduled reports of the agent (docs/PIANO-AGENTE.md, 5.6): daily summary and
// weekly analysis, plus /report on demand. The supervisor only decides when;
// the numbers come from the MCP tool get_report_data, the text from the agent.

const WEEKDAYS = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];

const pad = (n) => String(n).padStart(2, '0');

function formatLocal(ms) {
	const d = new Date(ms);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localDay(ms) {
	return formatLocal(ms).slice(0, 10);
}

// "venerdì", "venerdi" or 5 (0 = domenica) -> 0..6
export function parseWeekday(value) {
	if (Number.isInteger(value) && value >= 0 && value <= 6) return value;
	const name = String(value ?? '').trim().toLowerCase().replace(/i$/, 'ì');
	const index = WEEKDAYS.indexOf(name);
	if (index < 0) throw new Error(`giorno della settimana non valido: ${value}`);
	return index;
}

// "18:00" on the local day containing ms
export function slotOn(ms, time) {
	const match = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? ''));
	if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error(`orario non valido: ${time}`);
	const date = new Date(ms);
	date.setHours(Number(match[1]), Number(match[2]), 0, 0);
	return date.getTime();
}

// Same local time N days earlier (also across a daylight saving change)
export function daysBefore(ms, days) {
	const date = new Date(ms);
	date.setDate(date.getDate() - days);
	return date.getTime();
}

export const REPORT_KINDS = {
	daily: { job: 'report_daily', label: 'giornaliero', days: 1 },
	weekly: { job: 'report_weekly', label: 'settimanale', days: 7 }
};

export function buildReportPrompt({ kind, fromMs, toMs }) {
	const period = `Periodo: da ${formatLocal(fromMs)} a ${formatLocal(toMs)}.`;
	switch (kind) {
		case 'daily':
			return `REPORT GIORNALIERO. ${period}\n\nSegui la procedura del report giornaliero di CLAUDE.md.`;
		case 'weekly':
			return `REPORT SETTIMANALE. ${period}\n\nSegui la procedura del report settimanale di CLAUDE.md.`;
		default:
			return `REPORT SU RICHIESTA dell'utente. ${period}\n\nSegui la procedura del report su richiesta di CLAUDE.md.`;
	}
}

export class ReportScheduler {
	// publishJob(job): sends a job to the launcher; launcherOnline(): boolean
	constructor({ state, config, publishJob, launcherOnline, log = console, now = () => Date.now() }) {
		this.state = state;
		this.config = config;
		this.publishJob = publishJob;
		this.launcherOnline = launcherOnline;
		this.log = log;
		this.now = now;
		this.weekday = config.weekly?.enabled ? parseWeekday(config.weekly.day) : null;
		// Checked at startup: a typo must show up in the log, not at 18:00
		if (config.daily?.enabled) slotOn(0, config.daily.time);
		if (config.weekly?.enabled) slotOn(0, config.weekly.time);
	}

	// The slot of today for one kind of report, or null if none today
	slotToday(kind, now) {
		const settings = this.config[kind];
		if (!settings?.enabled) return null;
		if (kind === 'weekly' && new Date(now).getDay() !== this.weekday) return null;
		return slotOn(now, settings.time);
	}

	async tick() {
		if (!this.config.enabled) return;
		const now = this.now();
		for (const kind of Object.keys(REPORT_KINDS)) {
			const slot = this.slotToday(kind, now);
			if (slot === null) continue;
			const stateKey = `reports.${kind}.lastSlot`;
			if (this.state.get(stateKey) === localDay(slot)) continue;

			// A short delay lets the aggregation close the last hour
			const dueAt = slot + (this.config.delayMinutes ?? 0) * 60000;
			if (now < dueAt) continue;
			if (now > slot + this.config.maxDelayHours * 3600000) {
				await this.state.set(stateKey, localDay(slot));
				this.log.warn(`[WARN] Report ${REPORT_KINDS[kind].label} of ${localDay(slot)} skipped: launcher not available in time`);
				continue;
			}
			if (!this.launcherOnline()) continue;

			await this.state.set(stateKey, localDay(slot));
			await this.publish(kind, daysBefore(slot, REPORT_KINDS[kind].days), slot, 'supervisor');
		}
	}

	async publish(kind, fromMs, toMs, requestedBy) {
		const jobKind = REPORT_KINDS[kind]?.job ?? 'report';
		const job = {
			jobId: `${jobKind}-${this.now()}`,
			kind: jobKind,
			prompt: buildReportPrompt({ kind, fromMs, toMs }),
			requestedBy,
			replyTelegram: true
		};
		await this.publishJob(job);
		this.log.log(`[REPORT] ${job.jobId}: ${formatLocal(fromMs)} → ${formatLocal(toMs)}`);
		return job;
	}

	// /report [giorno|settimana]: Sonnet on the last 24 h or 7 days, up to now
	async onDemand(period = 'giorno') {
		const days = { giorno: 1, settimana: 7 }[period];
		if (!days) return { ok: false, message: 'Uso: /report [giorno|settimana]' };
		const toMs = this.now();
		await this.publish('ondemand', daysBefore(toMs, days), toMs, 'telegram');
		return { ok: true };
	}

	// Next scheduled reports, for /help-like messages
	describe() {
		const parts = [];
		if (this.config.daily?.enabled) parts.push(`giornaliero alle ${this.config.daily.time}`);
		if (this.config.weekly?.enabled) parts.push(`settimanale il ${WEEKDAYS[this.weekday]} alle ${this.config.weekly.time}`);
		return parts.length ? `Report programmati: ${parts.join(', ')}.` : 'Nessun report programmato.';
	}
}
