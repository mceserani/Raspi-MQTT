// raspi-agent-launcher: runs the agent (Claude Code headless) on request
// (docs/PIANO-AGENTE.md, 5.1 and 5.7). Runs as the raspi-agent user with
// agent.env; receives jobs on supervisor/agent/jobs, one run at a time,
// within the daily budget, and hands the answers back to the supervisor.
import os from 'node:os';
import path from 'node:path';
import mqtt from 'mqtt';
import { loadAgentConfig, loadEnvConfig } from '../mcp/config.js';
import { Budget } from './budget.js';
import { Launcher } from './jobs.js';
import { buildClaudeArgs, runClaude } from './runner.js';

const env = loadEnvConfig();
const config = await loadAgentConfig(env.configFile);
if (!config.launcher) throw new Error(`${env.configFile}: missing section "launcher"`);

const home = os.homedir();
const paths = {
	claudeBin: process.env.CLAUDE_BIN || path.join(home, '.local', 'bin', 'claude'),
	workspace: process.env.AGENT_WORKSPACE || path.join(home, 'workspace'),
	mcpConfig: process.env.AGENT_MCP_CONFIG || path.join(home, '.config', 'raspi-agent', 'mcp.json'),
	budgetFile: process.env.AGENT_BUDGET_FILE || path.join(home, '.local', 'state', 'raspi-agent', 'budget.json')
};

const budget = new Budget(paths.budgetFile, config.launcher);
await budget.load();

const topics = {
	jobs: `${env.agentTopic}/jobs`,
	results: `${env.agentTopic}/results`,
	telegram: `${env.agentTopic}/telegram`,
	status: `${env.agentTopic}/launcher`
};

const client = mqtt.connect(env.mqtt.broker, {
	clientId: `raspi-agent-launcher-${Math.random().toString(16).slice(2, 8)}`,
	username: env.mqtt.username,
	password: env.mqtt.password,
	reconnectPeriod: 3000,
	will: { topic: topics.status, payload: JSON.stringify({ online: false }), qos: 1, retain: true }
});

async function publish(kind, payload) {
	if (!client.connected) {
		console.warn(`[WARN] MQTT offline, ${kind} not published`);
		return;
	}
	const message = JSON.stringify({ ...payload, at: new Date().toISOString() });
	await client.publishAsync(topics[kind], message, { qos: 1, retain: kind === 'status' });
}

const launcher = new Launcher({
	config: config.launcher,
	budget,
	publish,
	run: (job, model, jobConfig) => runClaude({
		claudeBin: paths.claudeBin,
		cwd: paths.workspace,
		args: buildClaudeArgs({ model, tools: jobConfig.tools, maxTurns: jobConfig.maxTurns, mcpConfig: paths.mcpConfig, systemPrompt: config.launcher.systemPrompt }),
		prompt: job.prompt,
		timeoutSeconds: config.launcher.timeoutSeconds
	})
});

client.on('connect', () => {
	console.log(`[✓] MQTT connected to ${env.mqtt.broker}`);
	client.subscribe(topics.jobs, { qos: 1 }, (error) => {
		if (error) console.error('[ERROR] MQTT subscribe failed:', error.message);
	});
	publish('status', launcher.status());
});
client.on('error', (error) => console.error('[ERROR] MQTT error:', error.message));

client.on('message', (topic, payload) => {
	if (topic !== topics.jobs) return;
	let job;
	try {
		job = JSON.parse(payload.toString());
	} catch {
		console.warn('[WARN] Invalid job payload');
		return;
	}
	launcher.submit(job).catch((error) => console.error('[ERROR] Job submit failed:', error.message));
});

console.log(`[INFO] raspi-agent-launcher running (budget ${config.launcher.maxRunsPerDay}/day, Sonnet ${config.launcher.maxSonnetRunsPerDay})`);

async function shutdown() {
	console.log('[INFO] Shutting down...');
	try {
		if (client.connected) await client.publishAsync(topics.status, JSON.stringify({ online: false }), { qos: 1, retain: true });
		await client.endAsync();
	} catch (error) {
		console.error('[ERROR] Shutdown:', error.message);
	}
	process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
