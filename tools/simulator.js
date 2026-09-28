// Simulator of labsens-mqtt.js and battery-mqtt.js: same topics and payloads,
// no Modbus hardware. Lets the supervisor, the MCP server and the dashboards
// be tested on a PC. The real battery-cmd-bridge.js can run alongside it.
//
// Usage: node --env-file=.env tools/simulator.js [--broker] [--speed N] [--no-lab] [--no-battery] [--quiet]
//   --broker   also start an in-process MQTT broker on the MQTT_BROKER port
//   --speed N  battery time runs N times faster (a full cycle in minutes)
// Type "help" on stdin for the fault-injection commands.
import mqtt from 'mqtt';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const LAB_TOPIC = 'sensors/lab';
const BATTERY_TOPIC = process.env.BATTERY_MQTT_TOPIC ?? 'sensors/battery';

const LAB_SENSORS = [
	{ name: 'temperature', unit: '°C', topic: 'temperature', base: 22, amplitude: 2, noise: 0.05 },
	{ name: 'humidity', unit: '%', topic: 'humidity', base: 45, amplitude: 5, noise: 0.2 },
	{ name: 'pm10', unit: 'µg/m³', topic: 'pm10', base: 12, amplitude: 4, noise: 1 },
	{ name: 'pm2_5', unit: 'µg/m³', topic: 'pm2_5', base: 7, amplitude: 3, noise: 0.5 },
	{ name: 'voc', unit: 'ppb', topic: 'voc', base: 100, amplitude: 30, noise: 3 },
	{ name: 'nox', unit: 'ppb', topic: 'nox', base: 1, amplitude: 0.5, noise: 0.1 }
];

const NTC_SENSOR = { name: 'ntc_temperature', unit: '°C', topic: 'ntc/temperature', divisor: 10 };

const STATE_TOPICS = [
	{ key: 'currentSetpointMa', topic: 'current-setpoint', unit: 'mA' },
	{ key: 'voltageSetpointMv', topic: 'voltage-setpoint', unit: 'mV' },
	{ key: 'currentMeasuredMa', topic: 'current-measured', unit: 'mA' },
	{ key: 'voltageMeasuredMv', topic: 'voltage-measured', unit: 'mV' },
	{ key: 'runState', topic: 'run-state', unit: 'code' },
	{ key: 'runStateLabel', topic: 'run-state-label', unit: 'label' },
	{ key: 'batteryType', topic: 'battery-type', unit: 'code' }
];

const RUN_STATE_LABELS = { 0: 'stopped', 1: 'charge', 2: 'discharge' };

function gaussianNoise(sigma) {
	return (Math.random() + Math.random() + Math.random() - 1.5) * sigma;
}

function toSigned16(value) {
	return value > 0x7fff ? value - 0x10000 : value;
}

// labsens-mqtt.js reads an unsigned register and divides it: negative values
// come out as ~655. The simulator reproduces this on purpose.
export function labsensEncode(value, divisor) {
	const raw = ((Math.round(value * divisor) % 0x10000) + 0x10000) % 0x10000;
	return raw / divisor;
}

export class LabModel {
	constructor() {
		this.overrides = new Map();
	}

	read(date = new Date()) {
		const hours = date.getHours() + date.getMinutes() / 60;
		const daily = Math.sin(((hours - 9) / 24) * 2 * Math.PI);
		const values = {};

		for (const sensor of LAB_SENSORS) {
			const value = this.overrides.has(sensor.name)
				? this.overrides.get(sensor.name)
				: Math.max(0, sensor.base + sensor.amplitude * daily + gaussianNoise(sensor.noise));
			values[sensor.name] = labsensEncode(value, 100);
		}

		const ntc = this.overrides.has(NTC_SENSOR.name)
			? this.overrides.get(NTC_SENSOR.name)
			: this.overrides.get('temperature') ?? 22 + 2 * daily + 0.3 + gaussianNoise(0.1);
		values[NTC_SENSOR.name] = labsensEncode(ntc, NTC_SENSOR.divisor);

		return values;
	}
}

// Simple cell: linear open-circuit voltage + internal resistance, CC/CV charge.
// Assumption: measured current is positive in charge and negative in discharge.
export class BatteryModel {
	constructor({ capacityMah = 2000, resistanceOhm = 0.08, ocvEmptyMv = 3000, ocvFullMv = 4200, soc = 0.5, batteryType = 0 } = {}) {
		this.capacityMah = capacityMah;
		this.resistanceOhm = resistanceOhm;
		this.ocvEmptyMv = ocvEmptyMv;
		this.ocvFullMv = ocvFullMv;
		this.soc = soc;
		this.currentSetpointMa = 500;
		this.voltageSetpointMv = 4200;
		this.runState = 0;
		this.batteryType = batteryType;
		this.currentMa = 0;
		this.fault = 'none';
	}

	get ocvMv() {
		return this.ocvEmptyMv + (this.ocvFullMv - this.ocvEmptyMv) * this.soc;
	}

	step(seconds) {
		if (this.runState === 1) {
			const cvLimitMa = Math.max(0, (this.voltageSetpointMv - this.ocvMv) / this.resistanceOhm);
			this.currentMa = Math.min(Math.abs(this.currentSetpointMa), cvLimitMa);
		} else if (this.runState === 2) {
			this.currentMa = this.soc > 0 ? -Math.abs(this.currentSetpointMa) : 0;
		} else {
			this.currentMa = 0;
		}

		this.soc += (this.currentMa * seconds) / 3600 / this.capacityMah;
		this.soc = Math.min(1, Math.max(0, this.soc));
	}

	applyCommand({ command, value, register }) {
		const target = command === 'write_register' ? Number(register) : { set_current_ma: 400, set_voltage_mv: 401, set_run_state: 404 }[command];
		const number = Number(value);

		if (target === undefined) {
			throw new Error(`Unsupported command: ${command}`);
		}
		if (!Number.isInteger(number)) {
			throw new Error(`${command} requires integer value`);
		}

		switch (target) {
			case 400:
				this.currentSetpointMa = number;
				break;
			case 401:
				this.voltageSetpointMv = number;
				break;
			case 404:
				if (![0, 1, 2].includes(number)) {
					throw new Error('set_run_state supports only 0, 1 or 2');
				}
				this.runState = number;
				break;
			case 405:
				this.batteryType = number;
				break;
			default:
				// Other registers have no effect on the model
				break;
		}

		return { label: command, register: target, value: number };
	}

	read() {
		let currentMa = this.currentMa + (this.currentMa === 0 ? 0 : gaussianNoise(2));
		let voltageMv = this.ocvMv + this.currentMa * this.resistanceOhm + gaussianNoise(1);

		if (this.fault === 'overvoltage') {
			voltageMv += 800;
		} else if (this.fault === 'drift') {
			currentMa *= 0.7;
		}

		return {
			currentSetpointMa: toSigned16(this.currentSetpointMa & 0xffff),
			voltageSetpointMv: toSigned16(this.voltageSetpointMv & 0xffff),
			currentMeasuredMa: Math.round(currentMa),
			voltageMeasuredMv: Math.round(voltageMv),
			runState: this.runState,
			runStateLabel: RUN_STATE_LABELS[this.runState] ?? 'unknown',
			batteryType: this.batteryType,
			timestamp: new Date().toISOString()
		};
	}
}

function parseArgs(argv) {
	const args = { broker: false, speed: 1, lab: true, battery: true, quiet: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--broker') args.broker = true;
		else if (arg === '--speed') args.speed = Number(argv[++i]);
		else if (arg === '--no-lab') args.lab = false;
		else if (arg === '--no-battery') args.battery = false;
		else if (arg === '--quiet') args.quiet = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (!Number.isFinite(args.speed) || args.speed <= 0) {
		throw new Error('--speed must be a positive number');
	}
	return args;
}

const HELP = `Commands:
  set <sensor> <value>   force a lab value (${LAB_SENSORS.map((s) => s.name).join(', ')}, ntc_temperature)
  clear [sensor]         remove one or all forced values
  pause <lab|battery> <s> stop publishing for s seconds (stale data)
  type <n>               battery type register (405)
  soc <0..1>             battery state of charge
  fault <none|overvoltage|drift|runstate>
                         overvoltage: +800 mV on the measured voltage
                         drift: measured current 30% below the real one
                         runstate: uncommanded switch to charge
  status                 print the current state
  help`;

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const brokerUrl = process.env.MQTT_BROKER ?? 'mqtt://localhost:1883';
	const log = (...parts) => {
		if (!args.quiet) console.log(...parts);
	};

	let devBroker = null;
	if (args.broker) {
		const { startDevBroker } = await import('./dev-broker.js');
		devBroker = await startDevBroker(Number(new URL(brokerUrl).port || 1883));
		console.log(`[INFO] Dev MQTT broker listening on ${devBroker.url}`);
	}

	const client = await mqtt.connectAsync(brokerUrl, {
		clientId: `simulator-${Math.random().toString(16).slice(2, 8)}`,
		username: process.env.MQTT_USERNAME,
		password: process.env.MQTT_PASSWORD
	});
	console.log(`[✓] Simulator connected to ${brokerUrl}`);

	const lab = new LabModel();
	const battery = new BatteryModel();
	const pausedUntil = { lab: 0, battery: 0 };

	if (args.battery) {
		await client.subscribeAsync(`${BATTERY_TOPIC}/command/dispatch`, { qos: 1 });
		client.on('message', async (topic, payloadBuffer) => {
			let payload;
			try {
				payload = JSON.parse(payloadBuffer.toString());
			} catch {
				return;
			}

			let ack;
			try {
				const applied = battery.applyCommand(payload);
				ack = { status: 'ok', message: `${applied.label} applied on register ${applied.register}`, register: applied.register, value: applied.value };
			} catch (error) {
				ack = { status: 'error', message: error.message };
			}

			await client.publishAsync(`${BATTERY_TOPIC}/command/ack`, JSON.stringify({
				...ack,
				command: payload.command,
				commandId: payload.commandId,
				timestamp: new Date().toISOString(),
				handledBy: 'simulator'
			}), { qos: 1 });
			log(`[CMD] ${payload.command}=${payload.value} -> ${ack.status}`);
		});
	}

	const timer = setInterval(async () => {
		const now = Date.now();
		try {
			if (args.lab && now >= pausedUntil.lab) {
				const values = lab.read();
				for (const sensor of [...LAB_SENSORS, NTC_SENSOR]) {
					await client.publishAsync(`${LAB_TOPIC}/${sensor.topic}`, JSON.stringify({
						value: values[sensor.name],
						unit: sensor.unit,
						timestamp: new Date().toISOString(),
						sensor: sensor.name
					}));
				}
			}

			if (args.battery) {
				battery.step(args.speed);
				if (now >= pausedUntil.battery) {
					const state = battery.read();
					await client.publishAsync(`${BATTERY_TOPIC}/state`, JSON.stringify(state), { retain: true });
					for (const field of STATE_TOPICS) {
						await client.publishAsync(`${BATTERY_TOPIC}/${field.topic}`, JSON.stringify({
							value: state[field.key],
							unit: field.unit,
							timestamp: state.timestamp,
							sensor: field.key
						}), { retain: true });
					}
				}
			}
		} catch (error) {
			console.error('[ERROR] Publish failed:', error.message);
		}
	}, 1000);

	const rl = readline.createInterface({ input: process.stdin });
	console.log('Type "help" for commands.');
	rl.on('line', (line) => {
		const [cmd, a, b] = line.trim().split(/\s+/);
		try {
			switch (cmd) {
				case 'set':
					if (!Number.isFinite(Number(b))) throw new Error('value must be a number');
					lab.overrides.set(a, Number(b));
					break;
				case 'clear':
					if (a) lab.overrides.delete(a);
					else lab.overrides.clear();
					break;
				case 'pause':
					if (!(a in pausedUntil)) throw new Error('pause lab|battery <seconds>');
					pausedUntil[a] = Date.now() + Number(b) * 1000;
					break;
				case 'type':
					battery.batteryType = Number(a);
					break;
				case 'soc':
					battery.soc = Math.min(1, Math.max(0, Number(a)));
					break;
				case 'fault':
					if (a === 'runstate') battery.runState = 1;
					else if (['none', 'overvoltage', 'drift'].includes(a)) battery.fault = a;
					else throw new Error('fault none|overvoltage|drift|runstate');
					break;
				case 'status':
					console.log({ labOverrides: Object.fromEntries(lab.overrides), battery: battery.read(), soc: battery.soc.toFixed(3), fault: battery.fault });
					return;
				case 'help':
				case '':
					console.log(HELP);
					return;
				default:
					throw new Error(`unknown command "${cmd}"`);
			}
			console.log('ok');
		} catch (error) {
			console.log(`error: ${error.message}`);
		}
	});

	const shutdown = async () => {
		clearInterval(timer);
		rl.close();
		await client.endAsync();
		if (devBroker) await devBroker.close();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error('[FATAL]', error.message);
		process.exit(1);
	});
}
