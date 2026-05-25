import mqtt from 'mqtt';

const MQTT_BROKER = process.env.MQTT_BROKER ?? 'mqtt://localhost:1883';
const MQTT_USERNAME = process.env.MQTT_USERNAME;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD;
const BASE_TOPIC = process.env.BATTERY_MQTT_TOPIC ?? 'sensors/battery';

const TOPICS = {
	request: `${BASE_TOPIC}/command/request`,
	dispatch: `${BASE_TOPIC}/command/dispatch`,
	ack: `${BASE_TOPIC}/command/ack`
};

const VALID_COMMANDS = new Set([
	'set_current_ma',
	'set_voltage_mv',
	'set_run_state',
	'write_register'
]);

function isInteger(value) {
	return Number.isInteger(Number(value));
}

function validatePayload(payload) {
	if (!payload || typeof payload !== 'object') {
		return 'Payload must be a JSON object';
	}

	if (typeof payload.command !== 'string' || !VALID_COMMANDS.has(payload.command)) {
		return `Unsupported command: ${payload.command}`;
	}

	if (!payload.commandId || typeof payload.commandId !== 'string') {
		return 'commandId is required and must be a string';
	}

	if (payload.command === 'write_register') {
		if (!isInteger(payload.register) || !isInteger(payload.value)) {
			return 'write_register requires integer register and value';
		}
		return null;
	}

	if (!isInteger(payload.value)) {
		return `${payload.command} requires integer value`;
	}

	if (payload.command === 'set_run_state') {
		const runState = Number(payload.value);
		if (![0, 1, 2].includes(runState)) {
			return 'set_run_state supports only 0, 1 or 2';
		}
	}

	return null;
}

async function publishAck(client, ackPayload) {
	await client.publishAsync(TOPICS.ack, JSON.stringify(ackPayload), { qos: 1, retain: false });
}

const client = mqtt.connect(MQTT_BROKER, {
	clientId: `battery-cmd-bridge-${Math.random().toString(16).slice(2, 8)}`,
	clean: true,
	reconnectPeriod: 3000,
	username: MQTT_USERNAME,
	password: MQTT_PASSWORD
});

client.on('connect', () => {
	console.log('[INFO] Connected to MQTT broker');
	client.subscribe(TOPICS.request, { qos: 1 }, (error) => {
		if (error) {
			console.error('[ERROR] Subscribe failed:', error.message);
			return;
		}

		console.log(`[INFO] Subscribed to ${TOPICS.request}`);
	});
});

client.on('reconnect', () => {
	console.log('[INFO] Reconnecting to MQTT broker...');
});

client.on('offline', () => {
	console.log('[WARN] MQTT client offline');
});

client.on('error', (error) => {
	console.error('[ERROR] MQTT error:', error.message);
});

client.on('message', async (topic, payloadBuffer) => {
	if (topic !== TOPICS.request) {
		return;
	}

	let payload;
	try {
		payload = JSON.parse(payloadBuffer.toString());
	} catch (error) {
		console.error('[WARN] Invalid JSON payload:', error.message);
		return;
	}

	const validationError = validatePayload(payload);
	if (validationError) {
		console.warn('[WARN] Invalid command payload:', validationError);
		await publishAck(client, {
			status: 'error',
			message: validationError,
			command: payload?.command,
			commandId: payload?.commandId,
			timestamp: new Date().toISOString(),
			handledBy: 'battery-cmd-bridge'
		});
		return;
	}

	const dispatchPayload = {
		...payload,
		forwardedBy: 'battery-cmd-bridge',
		forwardedAt: new Date().toISOString()
	};

	try {
		await client.publishAsync(TOPICS.dispatch, JSON.stringify(dispatchPayload), { qos: 1, retain: false });
		console.log(`[CMD] Forwarded ${payload.command} (id=${payload.commandId})`);
	} catch (error) {
		console.error('[ERROR] Failed to forward command:', error.message);
		await publishAck(client, {
			status: 'error',
			message: `Failed to forward command: ${error.message}`,
			command: payload.command,
			commandId: payload.commandId,
			timestamp: new Date().toISOString(),
			handledBy: 'battery-cmd-bridge'
		});
	}
});

function shutdown() {
	console.log('[INFO] Shutting down...');
	client.end(true, () => {
		process.exit(0);
	});
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);