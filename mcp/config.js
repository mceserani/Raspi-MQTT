import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseNumber(value, fallback) {
	const parsed = Number(value);
	return value !== undefined && value !== '' && Number.isFinite(parsed) ? parsed : fallback;
}

// On the Pi these variables come from agent.env (setup-agent-prereqs.sh):
// read-only MariaDB user, MQTT, notes directory. No Telegram token here.
export function loadEnvConfig(env = process.env) {
	return {
		mqtt: {
			broker: env.MQTT_BROKER ?? 'mqtt://localhost:1883',
			username: env.MQTT_USERNAME || undefined,
			password: env.MQTT_PASSWORD || undefined
		},
		mariadb: {
			host: env.MARIADB_HOST ?? 'localhost',
			port: parseNumber(env.MARIADB_PORT, 3306),
			user: env.MARIADB_RO_USER ?? 'agent_ro',
			password: env.MARIADB_RO_PASSWORD,
			database: env.MARIADB_DATABASE ?? 'sensor_data'
		},
		batteryTable: env.BATTERY_DB_TABLE ?? 'battery_measurements',
		batteryTopic: env.BATTERY_MQTT_TOPIC ?? 'sensors/battery',
		statusTopic: env.SUPERVISOR_STATUS_TOPIC ?? 'supervisor/status',
		agentTopic: env.SUPERVISOR_AGENT_TOPIC ?? 'supervisor/agent',
		notesDir: path.resolve(env.AGENT_NOTES_DIR || path.join(os.homedir(), 'notes')),
		configFile: path.resolve(ROOT, env.AGENT_CONFIG_FILE || 'config/agent.json')
	};
}

export async function loadAgentConfig(filePath) {
	const config = JSON.parse(await readFile(filePath, 'utf8'));
	for (const section of ['commands', 'status', 'queries', 'summary', 'events', 'telegram', 'notes']) {
		if (!config[section]) {
			throw new Error(`${filePath}: missing section "${section}"`);
		}
	}
	return config;
}
