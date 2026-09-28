// Nearest-rank percentile on an already sorted array
export function percentile(sorted, p) {
	if (sorted.length === 0) {
		return null;
	}

	const rank = Math.ceil((p / 100) * sorted.length);
	return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

// Statistics of one bucket. samples: [{ t: ms, v: number|null }] sorted by t.
// The largest gap also counts the edges of the bucket, so an empty or
// truncated bucket shows how long data was missing.
export function summarize(samples, bucketStartMs, bucketEndMs) {
	const valid = samples.filter((sample) => typeof sample.v === 'number' && Number.isFinite(sample.v));
	const values = valid.map((sample) => sample.v).sort((a, b) => a - b);

	let maxGapMs = 0;
	let previous = bucketStartMs;
	for (const sample of valid) {
		maxGapMs = Math.max(maxGapMs, sample.t - previous);
		previous = sample.t;
	}
	maxGapMs = Math.max(maxGapMs, bucketEndMs - previous);

	if (values.length === 0) {
		return { samples: 0, avg: null, min: null, max: null, p95: null, maxGapS: maxGapMs / 1000 };
	}

	const sum = values.reduce((acc, value) => acc + value, 0);
	return {
		samples: values.length,
		avg: sum / values.length,
		min: values[0],
		max: values[values.length - 1],
		p95: percentile(values, 95),
		maxGapS: maxGapMs / 1000
	};
}

// Arithmetic mean of the values received in the last windowMs
export function windowMean(history, now, windowMs) {
	let sum = 0;
	let count = 0;
	for (let i = history.length - 1; i >= 0 && history[i].t > now - windowMs; i--) {
		sum += history[i].v;
		count++;
	}
	return count === 0 ? null : sum / count;
}
