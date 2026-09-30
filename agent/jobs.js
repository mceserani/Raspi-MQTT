import { randomUUID } from 'node:crypto';

// Queue of agent jobs: one Claude run at a time, daily budget, results
// published back. MQTT and the Claude process are injected (see launcher.js).
export class Launcher {
	// run(job, model, jobConfig) -> { ok, result, error, ... }
	// publish(kind, payload): kind = "results" | "telegram" | "status"
	constructor({ config, budget, run, publish, log = console }) {
		this.config = config;
		this.budget = budget;
		this.run = run;
		this.publish = publish;
		this.log = log;
		this.queue = [];
		this.running = null;
	}

	validate(job) {
		if (!job || typeof job !== 'object') return 'lavoro non valido';
		if (!this.config.jobs[job.kind]) return `tipo di lavoro sconosciuto: ${job.kind}`;
		if (typeof job.prompt !== 'string' || job.prompt.trim() === '') return 'prompt mancante';
		if (job.prompt.length > this.config.maxPromptChars) return `prompt troppo lungo (max ${this.config.maxPromptChars} caratteri)`;
		return null;
	}

	status() {
		return {
			online: true,
			running: this.running ? { jobId: this.running.jobId, kind: this.running.kind } : null,
			queued: this.queue.length,
			budget: this.budget.summary()
		};
	}

	async reply(job, text) {
		if (job.replyTelegram) {
			await this.publish('telegram', { text: text.slice(0, this.config.maxReplyChars), level: 'info' });
		}
	}

	async finish(job, outcome) {
		await this.publish('results', { jobId: job.jobId, kind: job.kind, requestedBy: job.requestedBy ?? null, eventIds: job.eventIds ?? null, ...outcome });
	}

	async submit(rawJob) {
		const job = { ...rawJob, jobId: rawJob?.jobId ?? randomUUID() };
		const invalid = this.validate(job);
		if (invalid) {
			this.log.warn(`[WARN] Job refused: ${invalid}`);
			await this.finish(job, { status: 'refused', error: invalid });
			return;
		}
		if (this.queue.length >= this.config.maxQueue) {
			await this.finish(job, { status: 'refused', error: 'coda piena' });
			await this.reply(job, '🤖 L\'agente è occupato e la coda è piena: riprova più tardi.');
			return;
		}
		this.queue.push(job);
		await this.publish('status', this.status());
		this.pump();
	}

	async pump() {
		if (this.running) return;
		while (this.queue.length > 0) {
			const job = this.queue.shift();
			this.running = job;
			await this.publish('status', this.status());
			try {
				await this.execute(job);
			} catch (error) {
				this.log.error(`[ERROR] Job ${job.jobId} failed:`, error.message);
			}
			this.running = null;
		}
		await this.publish('status', this.status());
	}

	async execute(job) {
		const jobConfig = this.config.jobs[job.kind];
		const plan = this.budget.plan(jobConfig.model, jobConfig.reserve ?? 0);
		if (plan.refused) {
			this.log.warn(`[WARN] Job ${job.jobId} refused: ${plan.refused}`);
			await this.finish(job, { status: 'refused', error: plan.refused });
			await this.reply(job, `🤖 Non posso rispondere: ${plan.refused}. Riprova domani o aumenta il budget in config/agent.json.`);
			return;
		}

		// Counted before the run: a crash cannot turn into unlimited retries
		await this.budget.consume(plan.model);
		this.log.log(`[JOB] ${job.jobId} ${job.kind} with ${plan.model}${plan.downgraded ? ' (Sonnet budget used up)' : ''}`);
		const result = await this.run(job, plan.model, jobConfig);
		const budget = this.budget.summary();

		if (!result.ok) {
			this.log.error(`[ERROR] Job ${job.jobId}: ${result.error}`);
			await this.finish(job, { status: 'error', model: plan.model, error: result.error, budget });
			await this.reply(job, `🤖 ⚠️ L'agente non è riuscito a completare il lavoro: ${result.error}`);
			return;
		}

		this.log.log(`[JOB] ${job.jobId} done in ${result.durationS ?? '?'} s, ${result.turns ?? '?'} turns`);
		await this.finish(job, { status: 'ok', model: plan.model, downgraded: plan.downgraded, result: result.result, turns: result.turns, durationS: result.durationS, budget });
		const note = plan.downgraded ? '\n\n(risposta di Haiku: quota Sonnet di oggi esaurita)' : '';
		await this.reply(job, `${result.result.trim()}${note}`);
	}
}
