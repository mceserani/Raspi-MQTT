import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseNumber(value, fallback) {
	if (value === undefined || value === null || value === '') {
		return fallback;
	}

	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function projectPath(value, fallback) {
	return path.resolve(PROJECT_ROOT, value || fallback);
}

export function loadEnvConfig(env = process.env) {
	return {
		mqtt: {
			broker: env.MQTT_BROKER ?? 'mqtt://localhost:1883',
			username: env.MQTT_USERNAME,
			password: env.MQTT_PASSWORD
		},
		mariadb: {
			host: env.MARIADB_HOST ?? 'localhost',
			port: parseNumber(env.MARIADB_PORT, 3306),
			user: env.MARIADB_USER ?? 'mceserani',
			password: env.MARIADB_PASSWORD,
			database: env.MARIADB_DATABASE ?? 'sensor_data'
		},
		tables: {
			lab: env.LABSENS_DB_TABLE ?? 'labsens_measurements',
			battery: env.BATTERY_DB_TABLE ?? 'battery_measurements'
		},
		labTopic: 'sensors/lab',
		batteryTopic: env.BATTERY_MQTT_TOPIC ?? 'sensors/battery',
		statusTopic: env.SUPERVISOR_STATUS_TOPIC ?? 'supervisor/status',
		profilesFile: projectPath(env.BATTERY_PROFILES_FILE, 'config/battery-profiles.json'),
		supervisorConfigFile: projectPath(env.SUPERVISOR_CONFIG_FILE, 'config/supervisor.json'),
		telegram: {
			token: env.TELEGRAM_BOT_TOKEN || null,
			chatId: env.TELEGRAM_CHAT_ID || null
		}
	};
}

export async function loadSupervisorConfig(filePath) {
	const config = JSON.parse(await readFile(filePath, 'utf8'));
	for (const section of ['lab', 'battery', 'interlock', 'health', 'aggregation', 'telegram']) {
		if (!config[section]) {
			throw new Error(`${filePath}: missing section "${section}"`);
		}
	}
	return config;
}
