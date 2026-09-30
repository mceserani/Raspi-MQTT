import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Daily budget of agent runs (the Claude subscription quota is shared with the
// user's personal use). Counts reset at local midnight and survive restarts.

export function localDay(ms) {
	const date = new Date(ms);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Chooses the model for a job: a Sonnet job becomes Haiku when the Sonnet
// quota is used up. Returns { model, downgraded } or { refused: reason }.
export function planRun(counts, requestedModel, limits) {
	if (counts.total >= limits.maxRunsPerDay) {
		return { refused: `budget giornaliero esaurito (${limits.maxRunsPerDay} esecuzioni)` };
	}
	if (requestedModel === 'sonnet' && counts.sonnet >= limits.maxSonnetRunsPerDay) {
		return { model: 'haiku', downgraded: true };
	}
	return { model: requestedModel, downgraded: false };
}

export class Budget {
	constructor(file, limits, { now = () => Date.now() } = {}) {
		this.file = file;
		this.limits = limits;
		this.now = now;
		this.state = { day: localDay(now()), total: 0, sonnet: 0 };
	}

	async load() {
		try {
			const saved = JSON.parse(await readFile(this.file, 'utf8'));
			if (saved.day === localDay(this.now())) this.state = saved;
		} catch {
			// no file yet or unreadable: start from zero
		}
	}

	counts() {
		const today = localDay(this.now());
		if (this.state.day !== today) this.state = { day: today, total: 0, sonnet: 0 };
		return this.state;
	}

	plan(requestedModel) {
		return planRun(this.counts(), requestedModel, this.limits);
	}

	async consume(model) {
		const counts = this.counts();
		counts.total++;
		if (model === 'sonnet') counts.sonnet++;
		await mkdir(path.dirname(this.file), { recursive: true });
		await writeFile(this.file, JSON.stringify(counts));
	}

	summary() {
		const { total, sonnet } = this.counts();
		return { used: total, max: this.limits.maxRunsPerDay, sonnetUsed: sonnet, sonnetMax: this.limits.maxSonnetRunsPerDay };
	}
}
