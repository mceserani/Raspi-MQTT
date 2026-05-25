import mqtt from 'mqtt';
import readline from 'node:readline';

const MQTT_BROKER = process.env.MQTT_BROKER ?? 'mqtt://iot-edge-1:1883';
const MQTT_USERNAME = process.env.MQTT_USERNAME;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD;
const BASE_TOPIC = process.env.BATTERY_MQTT_TOPIC ?? 'sensors/battery';

const TOPICS = {
	state: `${BASE_TOPIC}/state`,
	meta: `${BASE_TOPIC}/meta`,
	ack: `${BASE_TOPIC}/command/ack`,
	request: `${BASE_TOPIC}/command/request`
};

const ESC = '\x1b';
const ansi = {
	reset: `${ESC}[0m`,
	bold: `${ESC}[1m`,
	dim: `${ESC}[2m`,
	green: `${ESC}[32m`,
	yellow: `${ESC}[33m`,
	red: `${ESC}[31m`,
	cyan: `${ESC}[36m`,
	white: `${ESC}[97m`,
	bgBlue: `${ESC}[44m`,
	clear: `${ESC}[2J${ESC}[H`
};

const state = {
	connected: false,
	controller: null,
	battery: null,
	lastAck: null,
	ackHistory: [],
	lastUpdate: null,
	messageCount: 0
};

let rl = null;
let renderPending = false;

function randomId() {
	return `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

function pad(value, len, right = false) {
	const text = String(value ?? '');
	if (right) {
		return text.padStart(len).slice(-len);
	}

	return text.padEnd(len).slice(0, len);
}

function formatNullableNumber(value, suffix = '') {
	if (typeof value !== 'number' || Number.isNaN(value)) {
		return 'n/a';
	}

	return `${value}${suffix}`;
}

function render() {
	const now = new Date().toLocaleTimeString('it-IT');
	const status = state.connected
		? `${ansi.green}CONNECTED${ansi.reset}`
		: `${ansi.red}DISCONNECTED${ansi.reset}`;

	const battery = state.battery;
	const controller = state.controller;
	const lastAck = state.lastAck;

	const lines = [];
	lines.push(
		ansi.bgBlue +
		ansi.bold +
		ansi.white +
		` BATTERY REMOTE DASHBOARD ${pad('', 20)}${now} ` +
		ansi.reset
	);
	lines.push(` Broker: ${ansi.cyan}${MQTT_BROKER}${ansi.reset}`);
	lines.push(` Status: ${status}   Messages: ${state.messageCount}`);
	lines.push(ansi.dim + '-'.repeat(76) + ansi.reset);

	lines.push(ansi.bold + ' Battery state' + ansi.reset);
	lines.push(
		` Current setpoint: ${pad(formatNullableNumber(battery?.currentSetpointMa, ' mA'), 14)}   ` +
		`Voltage setpoint: ${pad(formatNullableNumber(battery?.voltageSetpointMv, ' mV'), 14)}`
	);
	lines.push(
		` Current measured: ${pad(formatNullableNumber(battery?.currentMeasuredMa, ' mA'), 14)}   ` +
		`Voltage measured: ${pad(formatNullableNumber(battery?.voltageMeasuredMv, ' mV'), 14)}`
	);
	lines.push(
		` Run state: ${pad(battery?.runStateLabel ?? 'n/a', 14)}   Battery type: ${pad(battery?.batteryType ?? 'n/a', 14)}`
	);
	lines.push(` Last update: ${state.lastUpdate ?? 'n/a'}`);

	lines.push('');
	lines.push(ansi.bold + ' Controller info' + ansi.reset);
	lines.push(
		` Address: ${controller?.controllerAddress ?? 'n/a'}   Firmware: ${controller?.firmwareVersion ?? 'n/a'}   Device: ${controller?.deviceCode ?? 'n/a'}`
	);

	lines.push('');
	lines.push(ansi.bold + ' Last command ACK' + ansi.reset);
	if (!lastAck) {
		lines.push(ansi.dim + ' No ACK received yet' + ansi.reset);
	} else {
		const ackColor = lastAck.status === 'ok' ? ansi.green : ansi.red;
		lines.push(
			` ${ackColor}${lastAck.status.toUpperCase()}${ansi.reset} cmd=${lastAck.command ?? 'n/a'} id=${lastAck.commandId ?? 'n/a'}`
		);
		lines.push(` message=${lastAck.message ?? 'n/a'} time=${lastAck.timestamp ?? 'n/a'}`);
	}

	lines.push(ansi.dim + '-'.repeat(76) + ansi.reset);
	lines.push(' Commands:');
	lines.push('  current <mA>      -> set current setpoint register 400');
	lines.push('  voltage <mV>      -> set voltage setpoint register 401');
	lines.push('  run <0|1|2>       -> set run state register 404');
	lines.push('  raw <reg> <value> -> raw write single register');
	lines.push('  help              -> print command help');
	lines.push('  quit              -> exit dashboard');

	process.stdout.write(ansi.clear + lines.join('\n') + '\n');
	if (rl) {
		rl.setPrompt('cmd> ');
		rl.prompt(true);
	}
}

function safeRender() {
	if (rl && typeof rl.line === 'string' && rl.line.length > 0) {
		renderPending = true;
		return;
	}

	renderPending = false;
	render();
}

function parseInteger(value) {
	const parsed = Number(value);
	if (!Number.isInteger(parsed)) {
		return null;
	}

	return parsed;
}

function buildCommandPayload(inputLine) {
	const tokens = inputLine.trim().split(/\s+/);
	if (tokens.length === 0 || !tokens[0]) {
		return null;
	}

	const [command, ...args] = tokens;
	const commandId = randomId();

	if (command === 'current' && args.length === 1) {
		const value = parseInteger(args[0]);
		if (value === null) {
			throw new Error('current richiede un intero: current <mA>');
		}

		return { commandId, command: 'set_current_ma', value };
	}

	if (command === 'voltage' && args.length === 1) {
		const value = parseInteger(args[0]);
		if (value === null) {
			throw new Error('voltage richiede un intero: voltage <mV>');
		}

		return { commandId, command: 'set_voltage_mv', value };
	}

	if (command === 'run' && args.length === 1) {
		const value = parseInteger(args[0]);
		if (value === null || ![0, 1, 2].includes(value)) {
			throw new Error('run accetta solo 0, 1 o 2');
		}

		return { commandId, command: 'set_run_state', value };
	}

	if (command === 'raw' && args.length === 2) {
		const register = parseInteger(args[0]);
		const value = parseInteger(args[1]);
		if (register === null || value === null) {
			throw new Error('raw richiede due interi: raw <register> <value>');
		}

		return { commandId, command: 'write_register', register, value };
	}

	if (command === 'help') {
		return { local: 'help' };
	}

	if (command === 'quit' || command === 'exit') {
		return { local: 'quit' };
	}

	throw new Error('Comando non riconosciuto. Digita help per la lista comandi.');
}

function printHelp() {
	const helpLines = [
		'',
		'Comandi disponibili:',
		'  current <mA>      imposta current setpoint',
		'  voltage <mV>      imposta voltage setpoint',
		'  run <0|1|2>       imposta run state',
		'  raw <reg> <value> scrittura raw su registro',
		'  quit              esce dal programma',
		''
	];

	process.stdout.write(helpLines.join('\n'));
}

const client = mqtt.connect(MQTT_BROKER, {
	clientId: `battery-remote-dashboard-${Math.random().toString(16).slice(2, 8)}`,
	clean: true,
	reconnectPeriod: 3000,
	username: MQTT_USERNAME,
	password: MQTT_PASSWORD
});

client.on('connect', () => {
	state.connected = true;
	client.subscribe([TOPICS.state, TOPICS.meta, TOPICS.ack], { qos: 1 }, (error) => {
		if (error) {
			console.error('[ERROR] Subscribe failed:', error.message);
		}
		safeRender();
	});
});

client.on('reconnect', () => {
	state.connected = false;
	safeRender();
});

client.on('offline', () => {
	state.connected = false;
	safeRender();
});

client.on('error', (error) => {
	state.connected = false;
	console.error('[ERROR] MQTT:', error.message);
	safeRender();
});

client.on('message', (topic, payloadBuffer) => {
	state.messageCount += 1;
	try {
		const payload = JSON.parse(payloadBuffer.toString());

		if (topic === TOPICS.state) {
			state.battery = payload;
			state.lastUpdate = payload.timestamp ?? new Date().toISOString();
		}

		if (topic === TOPICS.meta) {
			state.controller = payload;
		}

		if (topic === TOPICS.ack) {
			state.lastAck = payload;
			state.ackHistory.unshift(payload);
			if (state.ackHistory.length > 10) {
				state.ackHistory.pop();
			}
		}
	} catch (error) {
		console.error('[WARN] Invalid JSON payload on topic', topic, error.message);
	}

	safeRender();
});

rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
	terminal: true
});

rl.on('line', async (line) => {
	const text = line.trim();
	if (!text) {
		safeRender();
		return;
	}

	try {
		const payload = buildCommandPayload(text);
		if (!payload) {
			safeRender();
			return;
		}

		if (payload.local === 'help') {
			printHelp();
			safeRender();
			return;
		}

		if (payload.local === 'quit') {
			shutdown();
			return;
		}

		await client.publishAsync(
			TOPICS.request,
			JSON.stringify({
				...payload,
				source: 'battery-remote-dashboard',
				timestamp: new Date().toISOString()
			}),
			{ qos: 1, retain: false }
		);

		console.log(`[CMD] Sent ${payload.command} (id=${payload.commandId})`);
	} catch (error) {
		console.error('[CMD ERROR]', error.message);
	}

	if (renderPending) {
		renderPending = false;
	}
	safeRender();
});

function shutdown() {
	rl.close();
	client.end(true, () => {
		process.stdout.write(ansi.clear);
		process.exit(0);
	});
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

render();