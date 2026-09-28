import { execFile } from 'node:child_process';

// execFile that resolves with stdout even on a non-zero exit code
// (systemctl is-active exits 3 when a unit is inactive).
export function run(command, args) {
	return new Promise((resolve, reject) => {
		execFile(command, args, { maxBuffer: 16 * 1024 * 1024, timeout: 15000 }, (error, stdout) => {
			if (error && (error.code === 'ENOENT' || error.killed)) {
				reject(error);
				return;
			}
			resolve(stdout);
		});
	});
}

// Only counts: the text of the log never leaves this function
export function countJournalIssues(text) {
	let errors = 0;
	let warnings = 0;
	for (const line of text.split('\n')) {
		if (/\[(ERROR|FATAL|CMD ERROR)\]/.test(line)) errors++;
		else if (/\[WARN\]/.test(line)) warnings++;
	}
	return { errors, warnings };
}

export class HealthMonitor {
	constructor(config, { exec = run, log = console, enabled = process.platform === 'linux' } = {}) {
		this.config = config;
		this.exec = exec;
		this.log = log;
		this.enabled = enabled;
		this.last = null;
	}

	async check() {
		if (!this.enabled) return [];

		const units = Object.keys(this.config.services);
		let states;
		try {
			const output = await this.exec('systemctl', ['is-active', ...units]);
			states = output.trim().split('\n');
		} catch (error) {
			this.log.error('[ERROR] Health check disabled, systemctl not usable:', error.message);
			this.enabled = false;
			return [];
		}

		const services = {};
		const conditions = [];
		for (const [index, unit] of units.entries()) {
			const state = states[index] ?? 'unknown';
			const service = { state, errors: null, warnings: null };
			services[unit] = service;

			if (state !== 'active') {
				conditions.push({
					key: `health:inactive:${unit}`,
					source: 'health',
					type: 'service_inactive',
					severity: this.config.services[unit],
					message: `Servizio ${unit} non attivo (${state})`,
					details: { unit, state }
				});
				continue;
			}

			try {
				const journal = await this.exec('journalctl', ['-u', `${unit}.service`, `--since=-${this.config.journalWindow}`, '-o', 'cat', '--no-pager', '-q']);
				Object.assign(service, countJournalIssues(journal));
			} catch (error) {
				this.log.warn(`[WARN] Could not read the journal of ${unit}:`, error.message);
				continue;
			}

			if (service.errors >= this.config.errorThreshold) {
				conditions.push({
					key: `health:errors:${unit}`,
					source: 'health',
					type: 'journal_errors',
					severity: 'warning',
					message: `${service.errors} errori nel log di ${unit} negli ultimi ${this.config.journalWindow}`,
					details: { unit, ...service, window: this.config.journalWindow }
				});
			}
		}

		this.last = { at: new Date().toISOString(), services };
		return conditions;
	}
}
