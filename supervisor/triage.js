// Hands the warning/critical events to the agent for triage (docs/PIANO-AGENTE.md,
// 5.1 and 6). Events are batched and spaced out: the daily budget is small.
// agent_status: pending -> queued -> handled | escalated | error (skip = info)

const pad = (n) => String(n).padStart(2, '0');
function formatLocal(value) {
	const d = new Date(value);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function buildTriagePrompt(events) {
	const lines = events.map((e) => {
		const state = e.resolved_at ? `rientrato ${formatLocal(e.resolved_at)}` : 'ancora aperto';
		return `#${e.id} [${e.peak_severity}] ${e.source}/${e.type} dalle ${formatLocal(e.created_at)}, ${state}: ${e.message}`;
	});
	return `TRIAGE. Eventi del supervisore da valutare (${events.length}):\n${lines.join('\n')}\n\nSegui la procedura di triage di CLAUDE.md.`;
}

export function buildInvestigationPrompt({ eventIds, summary }) {
	return `INDAGINE richiesta dal triage.\nEventi: ${eventIds.map((id) => `#${id}`).join(', ')}\nSintesi del triage: ${summary}\n\nSegui la procedura di indagine di CLAUDE.md.`;
}

export class Triage {
	// publishJob(job): sends a job to the launcher; launcherOnline(): boolean
	constructor({ db, state, config, publishJob, launcherOnline, log = console, now = () => Date.now() }) {
		this.db = db;
		this.state = state;
		this.config = config;
		this.publishJob = publishJob;
		this.launcherOnline = launcherOnline;
		this.log = log;
		this.now = now;
		this.jobs = new Map();
		this.recovered = false;
	}

	ids(list) {
		return list.map(() => '?').join(', ');
	}

	async setStatus(ids, status, onlyIf) {
		if (ids.length === 0) return;
		await this.db.query(
			`UPDATE supervisor_events SET agent_status = ? WHERE id IN (${this.ids(ids)})${onlyIf ? ' AND agent_status = ?' : ''}`,
			[status, ...ids, ...(onlyIf ? [onlyIf] : [])]
		);
	}

	async tick() {
		if (!this.config.enabled || !this.db.ready || !this.launcherOnline()) return;

		// After a restart the jobs in flight are unknown: their events go back to pending
		if (!this.recovered) {
			await this.db.query('UPDATE supervisor_events SET agent_status = \'pending\' WHERE agent_status = \'queued\'');
			this.recovered = true;
		}

		const now = this.now();
		const events = await this.db.query(
			`SELECT id, created_at, resolved_at, source, type, peak_severity, message
			FROM supervisor_events
			WHERE agent_status = 'pending' AND peak_severity IN ('warning', 'critical') AND created_at >= ? AND created_at <= ?
			ORDER BY peak_severity = 'critical' DESC, created_at
			LIMIT ${Number(this.config.maxEventsPerJob)}`,
			[new Date(now - this.config.lookbackHours * 3600000), new Date(now - this.config.settleSeconds * 1000)]
		);
		if (events.length === 0) return;

		const critical = events.some((e) => e.peak_severity === 'critical');
		const gapMs = (critical ? this.config.criticalMinGapMinutes : this.config.minGapMinutes) * 60000;
		const lastJobAt = this.state.get('triage.lastJobAt', 0);
		if (now - lastJobAt < gapMs) return;

		const eventIds = events.map((e) => Number(e.id));
		const jobId = `triage-${now}`;
		await this.setStatus(eventIds, 'queued');
		this.jobs.set(jobId, eventIds);
		await this.state.set('triage.lastJobAt', now);
		await this.publishJob({ jobId, kind: 'triage', prompt: buildTriagePrompt(events), requestedBy: 'supervisor', replyTelegram: false, eventIds });
		this.log.log(`[TRIAGE] ${jobId}: ${eventIds.length} events sent to the agent`);
	}

	async onResult(result) {
		const eventIds = this.jobs.get(result.jobId) ?? (result.kind === 'triage' ? result.eventIds : null);
		if (!eventIds?.length) return;
		this.jobs.delete(result.jobId);
		// Refused (budget): back to pending, retried later. Failed: not retried.
		const status = result.status === 'ok' ? 'handled' : result.status === 'refused' ? 'pending' : 'error';
		await this.setStatus(eventIds, status, 'queued');
		this.log.log(`[TRIAGE] ${result.jobId} ${result.status}: events -> ${status}`);
	}

	async onEscalate({ eventIds, summary }) {
		const ids = (Array.isArray(eventIds) ? eventIds : []).map(Number).filter(Number.isInteger).slice(0, 20);
		if (typeof summary !== 'string' || summary.trim() === '') return;

		const today = new Date(this.now()).toDateString();
		const counter = this.state.get('triage.escalations', { day: today, count: 0 });
		const count = counter.day === today ? counter.count : 0;
		if (count >= this.config.maxEscalationsPerDay) {
			this.log.warn('[WARN] Escalation dropped: daily limit reached');
			return;
		}
		await this.state.set('triage.escalations', { day: today, count: count + 1 });

		await this.setStatus(ids, 'escalated');
		await this.publishJob({
			jobId: `investigate-${this.now()}`,
			kind: 'investigate',
			prompt: buildInvestigationPrompt({ eventIds: ids, summary: summary.trim().slice(0, 1000) }),
			requestedBy: 'triage',
			replyTelegram: true,
			eventIds: ids
		});
		this.log.log(`[TRIAGE] Escalation for events ${ids.join(', ')}`);
	}
}
