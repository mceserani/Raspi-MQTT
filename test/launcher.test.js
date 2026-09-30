import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Budget, planRun } from '../agent/budget.js';
import { Launcher } from '../agent/jobs.js';
import { buildClaudeArgs, parseClaudeOutput } from '../agent/runner.js';
import { createCommandHandler, formatAgent } from '../supervisor/commands.js';
import { silentLog } from './helpers.js';

const LIMITS = { maxRunsPerDay: 3, maxSonnetRunsPerDay: 1 };
const CONFIG = {
	...LIMITS,
	maxQueue: 2,
	maxPromptChars: 100,
	maxReplyChars: 50,
	jobs: { ask: { model: 'sonnet', maxTurns: 5, tools: ['get_live_status'] } }
};

test('planRun: total budget, Sonnet downgraded to Haiku', () => {
	assert.deepEqual(planRun({ total: 0, sonnet: 0 }, 'sonnet', LIMITS), { model: 'sonnet', downgraded: false });
	assert.deepEqual(planRun({ total: 1, sonnet: 1 }, 'sonnet', LIMITS), { model: 'haiku', downgraded: true });
	assert.match(planRun({ total: 3, sonnet: 1 }, 'haiku', LIMITS).refused, /esaurito/);
	// Automatic jobs leave the reserve free for the user
	assert.match(planRun({ total: 1, sonnet: 0 }, 'haiku', LIMITS, 2).refused, /riservate/);
	assert.equal(planRun({ total: 0, sonnet: 0 }, 'haiku', LIMITS, 2).model, 'haiku');
});

test('Budget persists the counts and resets them the next day', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'budget-'));
	try {
		let now = new Date(2026, 8, 30, 10).getTime();
		const file = path.join(dir, 'state', 'budget.json');
		const budget = new Budget(file, LIMITS, { now: () => now });
		await budget.consume('sonnet');
		await budget.consume('haiku');

		const reloaded = new Budget(file, LIMITS, { now: () => now });
		await reloaded.load();
		assert.deepEqual(reloaded.summary(), { used: 2, max: 3, sonnetUsed: 1, sonnetMax: 1 });

		now = new Date(2026, 9, 1, 0, 5).getTime();
		assert.equal(reloaded.summary().used, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('Claude arguments: MCP tools only, built-in tools denied, prompt not in argv', () => {
	const args = buildClaudeArgs({ model: 'haiku', tools: ['get_live_status', 'get_events'], maxTurns: 4, mcpConfig: '/x/mcp.json', systemPrompt: 'S' });
	assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__raspi__get_live_status,mcp__raspi__get_events');
	assert.match(args[args.indexOf('--disallowedTools') + 1], /Bash.*Read.*WebFetch/);
	assert.ok(args.includes('--strict-mcp-config'));
	assert.equal(args[args.indexOf('--max-turns') + 1], '4');
});

test('Claude JSON output parsing', () => {
	const ok = parseClaudeOutput('{"type":"result","subtype":"success","is_error":false,"result":"Tutto regolare","num_turns":3,"duration_ms":8200}');
	assert.deepEqual([ok.ok, ok.result, ok.turns, ok.durationS], [true, 'Tutto regolare', 3, 8]);
	assert.equal(parseClaudeOutput('{"subtype":"error_max_turns","is_error":true}').ok, false);
	assert.throws(() => parseClaudeOutput('not json'));
});

function makeLauncher({ run, used = 0 } = {}) {
	const published = [];
	let counts = { total: used, sonnet: 0 };
	const budget = {
		plan: (model, reserve) => planRun(counts, model, LIMITS, reserve),
		consume: async (model) => { counts = { total: counts.total + 1, sonnet: counts.sonnet + (model === 'sonnet' ? 1 : 0) }; },
		summary: () => ({ used: counts.total, max: 3, sonnetUsed: counts.sonnet, sonnetMax: 1 })
	};
	const runs = [];
	const launcher = new Launcher({
		config: CONFIG,
		budget,
		log: silentLog,
		publish: async (kind, payload) => published.push({ kind, payload }),
		run: run ?? (async (job, model) => {
			runs.push({ job, model });
			return { ok: true, result: `risposta ${runs.length}`, turns: 2, durationS: 5 };
		})
	});
	return { launcher, published, runs };
}

const only = (published, kind) => published.filter((p) => p.kind === kind).map((p) => p.payload);

test('Launcher: runs jobs one at a time and replies on Telegram', async () => {
	const { launcher, published, runs } = makeLauncher();
	await Promise.all([
		launcher.submit({ kind: 'ask', prompt: 'uno', replyTelegram: true }),
		launcher.submit({ kind: 'ask', prompt: 'due', replyTelegram: true })
	]);
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(runs.map((r) => [r.job.prompt, r.model]), [['uno', 'sonnet'], ['due', 'haiku']]);
	assert.deepEqual(only(published, 'telegram').map((t) => t.text), ['risposta 1', 'risposta 2\n\n(risposta di Haiku: quota Sonnet di oggi esaurita)'.slice(0, 50)]);
	assert.equal(only(published, 'results').every((r) => r.status === 'ok'), true);
	assert.equal(only(published, 'status').at(-1).running, null);
});

test('Launcher: invalid jobs and exhausted budget are refused without running', async () => {
	const { launcher, published, runs } = makeLauncher({ used: 3 });
	await launcher.submit({ kind: 'rm', prompt: 'x' });
	await launcher.submit({ kind: 'ask', prompt: 'x'.repeat(200) });
	await launcher.submit({ kind: 'ask', prompt: 'ok', replyTelegram: true });
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(runs.length, 0);
	const errors = only(published, 'results').map((r) => r.error);
	assert.match(errors[0], /sconosciuto/);
	assert.match(errors[1], /troppo lungo/);
	assert.match(errors[2], /esaurito/);
	assert.match(only(published, 'telegram')[0].text, /Non posso rispondere/);
});

test('Launcher: a failed run is reported to the user', async () => {
	const { launcher, published } = makeLauncher({ run: async () => ({ ok: false, error: 'interrotto dopo 300 s' }) });
	await launcher.submit({ kind: 'ask', prompt: 'x', replyTelegram: true });
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(only(published, 'results')[0].status, 'error');
	assert.match(only(published, 'telegram')[0].text, /non è riuscito/);
});

test('/ask sends the question to the agent', async () => {
	const asked = [];
	const agent = { online: true, running: null, queued: 0, budget: { used: 1, max: 10, sonnetUsed: 1, sonnetMax: 5 } };
	const handler = createCommandHandler({
		askAgent: async (text) => {
			asked.push(text);
			return { ok: true, agent };
		}
	});
	assert.match(await handler('ask', []), /Uso: \/ask/);
	assert.match(await handler('ask', ['com\'è', 'il', 'PM2.5?']), /inviata/);
	assert.deepEqual(asked, ['com\'è il PM2.5?']);
	assert.equal(formatAgent(agent), 'Agente: in attesa · oggi 1/10 esecuzioni (Sonnet 1/5)');
	assert.equal(formatAgent(null), 'Agente: non attivo');
});
