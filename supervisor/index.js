// raspi-supervisor: deterministic layer between the existing services and the
// agent (docs/PIANO-AGENTE.md, 5.1). Rules and events, safety interlock,
// aggregations, service health and Telegram. Uses 0 tokens.
import mqtt from 'mqtt';
import { loadProfiles, resolveActiveProfile } from '../lib/battery-profiles.js';
import { AgentLink } from './agent-link.js';
import { Aggregator } from './aggregator.js';
import { BOT_COMMANDS, createCommandHandler } from './commands.js';
import { loadEnvConfig, loadSupervisorConfig } from './config.js';
import { Database, EventStore, StateStore } from './db.js';
import { decodeLabValue, labSensorName } from './decode.js';
import { EventManager } from './events.js';
import { HealthMonitor } from './health.js';
import { Interlock } from './interlock.js';
import { RuleEngine } from './rules.js';
import { Notifier, TelegramBot } from './telegram.js';

const env = loadEnvConfig();
const config = await loadSupervisorConfig(env.supervisorConfigFile);
const startedAt = Date.now();

let profiles = { profiles: {} };
let profilesError = null;
async function reloadProfiles() {
	try {
		profiles = await loadProfiles(env.profilesFile);
		profilesError = null;
	} catch (error) {
		// Keep the last good profiles; with none, everything stays observe-only
		profilesError = error.message;
		console.error('[ERROR] Battery profiles:', error.message);
	}
}
await reloadProfiles();

const db = new Database(env.mariadb);
const state = new StateStore(db);
const eventStore = new EventStore(db);
const bot = new TelegramBot(env.telegram);
const notifier = new Notifier({ bot, config: config.telegram });
const events = new EventManager({ store: eventStore, notifier });
const agentLink = new AgentLink({ bot, events, config: config.telegram });

const engine = new RuleEngine(config, { profileProvider: activeProfile });
const interlock = new Interlock(config.interlock, {
	sendStop,
	onLatchChange: (latched) => state.set('interlock.latched', latched)
});
const health = new HealthMonitor(config.health);
const aggregator = new Aggregator({ db, state, config: config.aggregation, tables: env.tables });

function activeProfile() {
	return resolveActiveProfile(profiles, {
		batteryType: engine.battery?.state.batteryType,
		manualProfile: state.get('battery.manualProfile')
	});
}

// ─── MQTT ──────────────────────────────────────────────────────────────────
const TOPICS = {
	lab: `${env.labTopic}/#`,
	batteryState: `${env.batteryTopic}/state`,
	ack: `${env.batteryTopic}/command/ack`,
	dispatch: `${env.batteryTopic}/command/dispatch`,
	agent: `${env.agentTopic}/+`
};

let mqttDownSince = startedAt;
const client = mqtt.connect(env.mqtt.broker, {
	clientId: `raspi-supervisor-${Math.random().toString(16).slice(2, 8)}`,
	username: env.mqtt.username,
	password: env.mqtt.password,
	reconnectPeriod: 3000,
	will: { topic: env.statusTopic, payload: JSON.stringify({ online: false }), qos: 1, retain: true }
});

client.on('connect', () => {
	mqttDownSince = null;
	console.log(`[✓] MQTT connected to ${env.mqtt.broker}`);
	client.subscribe([TOPICS.lab, TOPICS.batteryState, TOPICS.ack, TOPICS.agent], { qos: 1 }, (error) => {
		if (error) console.error('[ERROR] MQTT subscribe failed:', error.message);
	});
});
client.on('offline', () => {
	mqttDownSince ??= Date.now();
	console.warn('[WARN] MQTT offline');
});
client.on('error', (error) => console.error('[ERROR] MQTT error:', error.message));

client.on('message', (topic, payloadBuffer) => {
	let payload;
	try {
		payload = JSON.parse(payloadBuffer.toString());
	} catch {
		return;
	}
	const now = Date.now();

	if (topic.startsWith(`${env.labTopic}/`)) {
		const sensor = labSensorName(topic, payload);
		const value = typeof payload.value === 'number' ? decodeLabValue(sensor, payload.value) : NaN;
		engine.onLab(sensor, value, now);
	} else if (topic === TOPICS.batteryState) {
		engine.onBattery(payload, now);
		const profile = activeProfile();
		interlock.onBatteryState(payload, {
			profile: profile.usable ? profile.profile : null,
			profileName: profile.name,
			ntc: engine.labValue('ntc_temperature')
		}, now);
	} else if (topic === TOPICS.ack) {
		engine.onAck(payload, now);
	} else if (topic.startsWith(`${env.agentTopic}/`)) {
		agentLink.handle(topic.slice(env.agentTopic.length + 1), payload);
	}
});

// Stop goes straight to command/dispatch: it must work even without the bridge
function sendStop(source) {
	const timestamp = new Date().toISOString();
	const payload = {
		commandId: `supervisor-${source}-${Date.now()}`,
		command: 'set_run_state',
		value: 0,
		source: `supervisor-${source}`,
		timestamp,
		forwardedBy: 'raspi-supervisor',
		forwardedAt: timestamp
	};
	client.publish(TOPICS.dispatch, JSON.stringify(payload), { qos: 1 }, (error) => {
		if (error) console.error('[ERROR] Stop publish failed:', error.message);
	});
	console.log(`[CMD] Stop sent (${source})`);
}

function waitFor(predicate, timeoutMs) {
	return new Promise((resolve) => {
		const started = Date.now();
		const timer = setInterval(() => {
			if (predicate()) {
				clearInterval(timer);
				resolve(true);
			} else if (Date.now() - started > timeoutMs) {
				clearInterval(timer);
				resolve(false);
			}
		}, 250);
	});
}

async function stopBattery(source) {
	if (!client.connected) {
		return { stopped: false, message: 'broker MQTT non connesso' };
	}
	const sentAt = Date.now();
	sendStop(source);
	events.record({ key: 'battery:manual_stop', source: 'battery', type: 'manual_stop', severity: 'info', message: `Stop batteria richiesto da ${source}`, details: { source } }, sentAt);
	const stopped = await waitFor(() => engine.battery?.state.runState === 0 && engine.battery.at > sentAt, 8000);
	return stopped ? { stopped: true } : { stopped: false, message: 'nessuna conferma dalla batteria entro 8 s' };
}

// ─── Status ────────────────────────────────────────────────────────────────
function status() {
	const now = Date.now();
	const profile = activeProfile();
	return {
		online: true,
		at: new Date(now).toISOString(),
		uptimeSeconds: (now - startedAt) / 1000,
		live: engine.snapshot(now),
		profile: { name: profile.name, source: profile.source, usable: profile.usable, reasons: profile.reasons, limits: profile.profile?.limits ?? null },
		interlock: { armed: profile.usable, latched: interlock.latched },
		openEvents: events.openEvents().map(({ key, severity, message, openedAt }) => ({ key, severity, message, openedAt })),
		health: health.last,
		agent: agentLink.launcher,
		databaseReady: db.ready
	};
}

function supervisorConditions(now) {
	const conditions = [];
	if (profilesError) {
		conditions.push({ key: 'supervisor:profiles_invalid', source: 'supervisor', type: 'config', severity: 'warning', message: 'File dei profili batteria non valido: si usano gli ultimi profili validi', details: { error: profilesError } });
	}
	if (mqttDownSince && now - mqttDownSince > 15000) {
		conditions.push({ key: 'supervisor:mqtt_down', source: 'supervisor', type: 'mqtt_down', severity: 'critical', message: 'Supervisore scollegato dal broker MQTT: monitoraggio e interblocco non funzionano', details: {} });
	}
	if (!db.ready && now - startedAt > 60000) {
		conditions.push({ key: 'supervisor:db_down', source: 'supervisor', type: 'db_down', severity: 'warning', message: 'MariaDB non raggiungibile: eventi in coda, aggregazioni sospese', details: {} });
	}
	return conditions;
}

// ─── Loops ─────────────────────────────────────────────────────────────────
eventStore.closeOrphans(startedAt);

let stateLoaded = false;
db.start(async () => {
	if (!stateLoaded) {
		await state.load();
		stateLoaded = true;
		if (!interlock.latched) interlock.restoreLatch(state.get('interlock.latched'));
	}
	await state.flush();
	eventStore.pump();
	aggregator.run();
});

const timers = [
	setInterval(() => {
		const now = Date.now();
		const { conditions, events: oneShots } = engine.evaluate(now);
		for (const event of [...oneShots, ...interlock.drainEvents()]) {
			events.record(event, now);
		}
		events.sync([...conditions, ...interlock.conditions(), ...supervisorConditions(now)], now);
		notifier.tick();
	}, 1000),

	setInterval(() => {
		if (client.connected) {
			client.publish(env.statusTopic, JSON.stringify(status()), { retain: true, qos: 1 });
		}
	}, config.statusPublishSeconds * 1000),

	setInterval(async () => engine.setHealth(await health.check()), config.health.intervalSeconds * 1000),

	setInterval(() => aggregator.run(), config.aggregation.intervalSeconds * 1000)
];
engine.setHealth(await health.check());

// ─── Telegram ──────────────────────────────────────────────────────────────
const handleCommand = createCommandHandler({
	status,
	stop: stopBattery,
	openEvents: () => events.openEvents(),
	now: () => Date.now(),
	profiles: () => ({ names: Object.keys(profiles.profiles), active: activeProfile(), manual: state.get('battery.manualProfile') }),
	async setManualProfile(name) {
		await reloadProfiles();
		if (name && !profiles.profiles[name]) {
			return { ok: false, message: `Profilo sconosciuto: ${name}. Disponibili: ${Object.keys(profiles.profiles).join(', ') || 'nessuno'}` };
		}
		await state.set('battery.manualProfile', name);
		events.record({ key: 'battery:profile_declared', source: 'battery', type: 'profile_declared', severity: 'info', message: `Profilo batteria dichiarato: ${name ?? 'auto (registro 405)'}`, details: { profile: name } }, Date.now());
		return { ok: true, active: activeProfile() };
	},
	async askAgent(text) {
		if (!agentLink.launcher?.online) {
			return { ok: false, message: 'Il lanciatore dell\'agente non è attivo (raspi-agent-launcher).' };
		}
		if (!client.connected) {
			return { ok: false, message: 'Broker MQTT non connesso.' };
		}
		const job = { jobId: `ask-${Date.now()}`, kind: 'ask', prompt: text, requestedBy: 'telegram', replyTelegram: true };
		await client.publishAsync(`${env.agentTopic}/jobs`, JSON.stringify(job), { qos: 1 });
		return { ok: true, agent: agentLink.launcher };
	},
	async resetInterlock() {
		interlock.reset();
		events.record({ key: 'interlock:reset', source: 'interlock', type: 'reset', severity: 'info', message: 'Interblocco riarmato da Telegram', details: {} }, Date.now());
	}
});

if (bot.enabled) {
	await bot.setCommands(BOT_COMMANDS);
	bot.startPolling(handleCommand);
	bot.send('🟢 Supervisore avviato.');
} else {
	console.warn('[WARN] TELEGRAM_BOT_TOKEN not set: notifications only in the log');
}

console.log('[INFO] raspi-supervisor running');

// A bug in a secondary task must not take the interlock down with it
process.on('unhandledRejection', (error) => {
	console.error('[ERROR] Unhandled rejection:', error?.stack ?? error);
});

process.on('SIGHUP', () => {
	console.log('[INFO] SIGHUP: reloading battery profiles');
	reloadProfiles();
});

let shuttingDown = false;
async function shutdown() {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log('[INFO] Shutting down...');
	timers.forEach(clearInterval);
	bot.stop();
	try {
		if (client.connected) {
			await client.publishAsync(env.statusTopic, JSON.stringify({ online: false }), { retain: true, qos: 1 });
		}
		await client.endAsync();
		await db.close();
	} catch (error) {
		console.error('[ERROR] Shutdown:', error.message);
	}
	process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
