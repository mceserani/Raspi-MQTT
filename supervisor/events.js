import { SEVERITY_RANK } from './rules.js';

// Turns the set of active conditions into events: a new key opens an event,
// a changed severity updates it, a key that disappears resolves it.
// One-shot events are opened and resolved at once.
export class EventManager {
	constructor({ store, notifier }) {
		this.store = store;
		this.notifier = notifier;
		this.open = new Map();
	}

	sync(conditions, now) {
		const seen = new Set();

		for (const condition of conditions) {
			seen.add(condition.key);
			const event = this.open.get(condition.key);

			if (!event) {
				const created = { ...condition, peakSeverity: condition.severity, openedAt: now, resolvedAt: null };
				this.open.set(condition.key, created);
				this.store.insert(created);
				this.notifier.notify(created, 'open');
				continue;
			}

			// A higher step of the same severity (thresholds with several steps) is
			// notified like an escalation
			const higherStep = condition.severity === event.severity && (condition.step ?? 0) > (event.step ?? 0);
			const escalated = SEVERITY_RANK[condition.severity] > SEVERITY_RANK[event.severity] || higherStep;
			const changed = condition.severity !== event.severity;
			event.message = condition.message;
			event.details = condition.details;
			event.step = condition.step;
			if (changed) {
				event.severity = condition.severity;
				if (escalated) event.peakSeverity = condition.severity;
			}
			if (changed || higherStep) {
				this.store.update(event, now);
				if (escalated) this.notifier.notify(event, 'escalated');
			}
		}

		for (const [key, event] of this.open) {
			if (seen.has(key)) continue;
			this.open.delete(key);
			event.resolvedAt = now;
			this.store.resolve(event);
			this.notifier.notify(event, 'resolved');
		}
	}

	record(oneShot, now) {
		const event = { ...oneShot, peakSeverity: oneShot.severity, openedAt: now, resolvedAt: now };
		this.store.insert(event);
		this.notifier.notify(event, 'oneshot');
	}

	openEvents() {
		return [...this.open.values()].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.openedAt - b.openedAt);
	}
}
