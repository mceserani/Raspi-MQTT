import ModbusRTU from 'modbus-serial';
import mqtt from 'mqtt';
import pkg from 'influx';

const { InfluxDB } = pkg;

const MQTT_BROKER = process.env.MQTT_BROKER ?? 'mqtt://localhost:1883';
const MQTT_USERNAME = process.env.MQTT_USERNAME;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD;

function parseNumber(value, fallback) {
	if (value === undefined || value === null || value === '') {
		return fallback;
	}

	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

const CONFIG = {
	modbus: {
		port: process.env.BATTERY_MODBUS_PORT ?? '/dev/ttyUSB1',
		baudRate: parseNumber(process.env.BATTERY_BAUD_RATE, 115200),
		address: parseNumber(process.env.BATTERY_MODBUS_ADDRESS, 4),
		timeout: parseNumber(process.env.BATTERY_MODBUS_TIMEOUT, 1000)
	},
	mqtt: {
		broker: MQTT_BROKER,
		username: MQTT_USERNAME,
		password: MQTT_PASSWORD,
		baseTopic: process.env.BATTERY_MQTT_TOPIC ?? 'sensors/battery'
	},
	influxdb: {
		host: process.env.INFLUX_HOST ?? 'localhost',
		port: parseNumber(process.env.INFLUX_PORT, 8086),
		database: process.env.INFLUX_DATABASE ?? 'sensor_data',
		username: process.env.INFLUX_USERNAME ?? 'influxdb',
		password: process.env.INFLUX_PASSWORD ?? 'influxdb'
	},
	pollInterval: parseNumber(process.env.BATTERY_POLL_INTERVAL, 1000)
};

const REGISTER_MAP = {
	firmwareVersion: 0,
	controllerAddress: 1,
	deviceCode: 8,
	baudRateCode: 13,
	currentSetpoint: 400,
	voltageSetpoint: 401,
	currentMeasured: 402,
	voltageMeasured: 403,
	runState: 404,
	batteryType: 405
};

const COMMAND_TOPICS = {
	request: 'command/request',
	dispatch: 'command/dispatch',
	ack: 'command/ack'
};

function toSigned16(value) {
	return value > 0x7fff ? value - 0x10000 : value;
}

function toUnsigned16(value) {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < -32768 || parsed > 65535) {
		throw new Error(`Value out of 16-bit range: ${value}`);
	}

	if (parsed < 0) {
		return 0x10000 + parsed;
	}

	return parsed;
}

function decodeBaudRate(rawValue) {
	return rawValue * 9600;
}

function decodeRunState(rawValue) {
	switch (rawValue) {
		case 0:
			return 'stopped';
		case 1:
			return 'charge';
		case 2:
			return 'discharge';
		default:
			return 'unknown';
	}
}

const STATE_TOPICS = [
	{ key: 'currentSetpointMa', topic: 'current-setpoint', unit: 'mA' },
	{ key: 'voltageSetpointMv', topic: 'voltage-setpoint', unit: 'mV' },
	{ key: 'currentMeasuredMa', topic: 'current-measured', unit: 'mA' },
	{ key: 'voltageMeasuredMv', topic: 'voltage-measured', unit: 'mV' },
	{ key: 'runState', topic: 'run-state', unit: 'code' },
	{ key: 'runStateLabel', topic: 'run-state-label', unit: 'label' },
	{ key: 'batteryType', topic: 'battery-type', unit: 'code' }
];

class BatteryBridge {
	constructor(config) {
		this.config = config;
		this.modbusClient = new ModbusRTU();
		this.mqttClient = null;
		this.influxClient = new InfluxDB({
			host: config.influxdb.host,
			port: config.influxdb.port,
			database: config.influxdb.database,
			username: config.influxdb.username,
			password: config.influxdb.password
		});
		this.controllerInfo = null;
		this.isPolling = false;
		this.isRunning = false;
		this.pollTimer = null;
		this.modbusQueue = Promise.resolve();
	}

	async withModbusLock(action, operation) {
		const run = async () => {
			try {
				return await operation();
			} catch (error) {
				error.message = `[${action}] ${error.message}`;
				throw error;
			}
		};

		const task = this.modbusQueue.then(run, run);
		this.modbusQueue = task.catch(() => {
			// Keep queue alive after failures.
		});
		return task;
	}

	async connect() {
		console.log('[INFO] Connecting to Modbus device...');

		await this.modbusClient.connectRTUBuffered(this.config.modbus.port, {
			baudRate: this.config.modbus.baudRate
		});
		this.modbusClient.setID(this.config.modbus.address);
		this.modbusClient.setTimeout(this.config.modbus.timeout);
		console.log('[✓] Modbus connected');

		console.log('[INFO] Connecting to MQTT broker...');
		this.mqttClient = await mqtt.connectAsync(this.config.mqtt.broker, {
			username: this.config.mqtt.username,
			password: this.config.mqtt.password
		});
		this.mqttClient.on('error', (error) => {
			console.error('[ERROR] MQTT error:', error.message);
		});
		this.mqttClient.on('message', async (topic, payloadBuffer) => {
			await this.handleMqttMessage(topic, payloadBuffer);
		});
		console.log('[✓] MQTT connected');

		console.log('[INFO] Testing InfluxDB connection...');
		const databases = await this.influxClient.getDatabaseNames();
		if (!databases.includes(this.config.influxdb.database)) {
			console.log(`[INFO] Creating InfluxDB database: ${this.config.influxdb.database}`);
			await this.influxClient.createDatabase(this.config.influxdb.database);
		}
		console.log('[✓] InfluxDB connected');
	}

	async subscribeCommandTopics() {
		const dispatchTopic = `${this.config.mqtt.baseTopic}/${COMMAND_TOPICS.dispatch}`;
		await this.mqttClient.subscribe(dispatchTopic, { qos: 1 });
		console.log(`[INFO] Subscribed to command topic: ${dispatchTopic}`);
	}

	async readRegistersWithFallback(startRegister, count, label) {
		return this.withModbusLock(`read-${label}`, async () => {
			try {
				const response = await this.modbusClient.readHoldingRegisters(startRegister, count);
				console.log(`[DEBUG] ${label}: readHoldingRegisters OK`);
				return response;
			} catch (holdingError) {
				console.warn(`[WARN] ${label}: readHoldingRegisters failed (${holdingError.message}), trying readInputRegisters...`);
				const response = await this.modbusClient.readInputRegisters(startRegister, count);
				console.log(`[DEBUG] ${label}: readInputRegisters OK`);
				return response;
			}
		});
	}

	async readSingleRegister(register, label) {
		const response = await Promise.race([
			this.readRegistersWithFallback(register, 1, label),
			new Promise((_, reject) => {
				setTimeout(() => reject(new Error(`Timeout reading register ${register}`)), this.config.modbus.timeout + 1000);
			})
		]);

		return response.data[0];
	}

	async readControllerInfo() {
		const firmwareVersion = await this.readSingleRegister(REGISTER_MAP.firmwareVersion, 'firmware version');
		const controllerAddress = await this.readSingleRegister(REGISTER_MAP.controllerAddress, 'controller address');
		const deviceCode = await this.readSingleRegister(REGISTER_MAP.deviceCode, 'device code');
		const baudRateCode = await this.readSingleRegister(REGISTER_MAP.baudRateCode, 'baud rate');

		return {
			firmwareVersion,
			controllerAddress,
			deviceCode,
			baudRate: decodeBaudRate(baudRateCode),
			baudRateCode,
			port: this.config.modbus.port,
			polledAt: new Date().toISOString()
		};
	}

	async readBatteryState() {
		const response = await Promise.race([
			this.readRegistersWithFallback(REGISTER_MAP.currentSetpoint, 6, 'battery state block 400-405'),
			new Promise((_, reject) => {
				setTimeout(() => reject(new Error('Battery state read timeout')), this.config.modbus.timeout + 1000);
			})
		]);

		const [currentSetpoint, voltageSetpoint, currentMeasured, voltageMeasured, runState, batteryType] = response.data;
		const timestamp = new Date().toISOString();

		return {
			currentSetpointMa: toSigned16(currentSetpoint),
			voltageSetpointMv: toSigned16(voltageSetpoint),
			currentMeasuredMa: toSigned16(currentMeasured),
			voltageMeasuredMv: toSigned16(voltageMeasured),
			runState,
			runStateLabel: decodeRunState(runState),
			batteryType,
			timestamp
		};
	}

	async publishControllerInfo() {
		if (!this.controllerInfo) {
			return;
		}

		await this.mqttClient.publish(
			`${this.config.mqtt.baseTopic}/meta`,
			JSON.stringify(this.controllerInfo),
			{ retain: true }
		);
	}

	async publishBatteryState(state) {
		const payload = {
			...state,
			controller: this.controllerInfo
				? {
						firmwareVersion: this.controllerInfo.firmwareVersion,
						controllerAddress: this.controllerInfo.controllerAddress,
						deviceCode: this.controllerInfo.deviceCode,
						baudRate: this.controllerInfo.baudRate
					}
				: undefined
		};

		await this.mqttClient.publish(
			`${this.config.mqtt.baseTopic}/state`,
			JSON.stringify(payload),
			{ retain: true }
		);

		for (const field of STATE_TOPICS) {
			await this.mqttClient.publish(
				`${this.config.mqtt.baseTopic}/${field.topic}`,
				JSON.stringify({
					value: state[field.key],
					unit: field.unit,
					timestamp: state.timestamp,
					sensor: field.key
				}),
				{ retain: true }
			);
		}

		console.log(`[MQTT] Published ${this.config.mqtt.baseTopic}/state`);
	}

	async saveBatteryState(state) {
		const tags = {};
		if (this.controllerInfo) {
			tags.controller_address = String(this.controllerInfo.controllerAddress);
			tags.device_code = String(this.controllerInfo.deviceCode);
			tags.firmware_version = String(this.controllerInfo.firmwareVersion);
		}

		await this.influxClient.writePoints([
			{
				measurement: 'battery_controller',
				tags,
				fields: {
					current_setpoint_ma: state.currentSetpointMa,
					voltage_setpoint_mv: state.voltageSetpointMv,
					current_measured_ma: state.currentMeasuredMa,
					voltage_measured_mv: state.voltageMeasuredMv,
					run_state: state.runState,
					battery_type: state.batteryType
				},
				timestamp: new Date(state.timestamp)
			}
		]);

		console.log('[InfluxDB] Saved battery_controller point');
	}

	async writeSingleRegister(register, value) {
		const unsignedValue = toUnsigned16(value);
		await this.withModbusLock(`write-reg-${register}`, async () => {
			await this.modbusClient.writeRegister(register, unsignedValue);
		});
	}

	async publishCommandAck(payload) {
		await this.mqttClient.publish(
			`${this.config.mqtt.baseTopic}/${COMMAND_TOPICS.ack}`,
			JSON.stringify(payload),
			{ qos: 1, retain: false }
		);
	}

	decodeCommand(commandPayload) {
		if (!commandPayload || typeof commandPayload !== 'object') {
			throw new Error('Command payload must be an object');
		}

		const { command, value, register } = commandPayload;
		if (!command || typeof command !== 'string') {
			throw new Error('Command name is required');
		}

		if (command === 'set_current_ma') {
			if (!Number.isInteger(Number(value))) {
				throw new Error('set_current_ma requires integer value');
			}
			return {
				label: 'set_current_ma',
				register: REGISTER_MAP.currentSetpoint,
				value: Number(value)
			};
		}

		if (command === 'set_voltage_mv') {
			if (!Number.isInteger(Number(value))) {
				throw new Error('set_voltage_mv requires integer value');
			}
			return {
				label: 'set_voltage_mv',
				register: REGISTER_MAP.voltageSetpoint,
				value: Number(value)
			};
		}

		if (command === 'set_run_state') {
			const runState = Number(value);
			if (!Number.isInteger(runState) || ![0, 1, 2].includes(runState)) {
				throw new Error('set_run_state supports only 0, 1 or 2');
			}

			return {
				label: 'set_run_state',
				register: REGISTER_MAP.runState,
				value: runState
			};
		}

		if (command === 'write_register') {
			const targetRegister = Number(register);
			const targetValue = Number(value);
			if (!Number.isInteger(targetRegister) || !Number.isInteger(targetValue)) {
				throw new Error('write_register requires integer register and value');
			}

			return {
				label: 'write_register',
				register: targetRegister,
				value: targetValue
			};
		}

		throw new Error(`Unsupported command: ${command}`);
	}

	async handleCommand(commandPayload) {
		const commandId = commandPayload?.commandId;
		const command = commandPayload?.command;

		try {
			const decoded = this.decodeCommand(commandPayload);
			await this.writeSingleRegister(decoded.register, decoded.value);
			const refreshedState = await this.readBatteryState();
			await Promise.all([
				this.publishBatteryState(refreshedState),
				this.saveBatteryState(refreshedState),
				this.publishCommandAck({
					status: 'ok',
					message: `${decoded.label} applied on register ${decoded.register}`,
					command,
					commandId,
					register: decoded.register,
					value: decoded.value,
					timestamp: new Date().toISOString(),
					handledBy: 'battery-mqtt'
				})
			]);
			console.log(`[CMD] Applied ${decoded.label} (id=${commandId ?? 'n/a'})`);
		} catch (error) {
			console.error('[CMD ERROR]', error.message);
			await this.publishCommandAck({
				status: 'error',
				message: error.message,
				command,
				commandId,
				timestamp: new Date().toISOString(),
				handledBy: 'battery-mqtt'
			});
		}
	}

	async handleMqttMessage(topic, payloadBuffer) {
		const dispatchTopic = `${this.config.mqtt.baseTopic}/${COMMAND_TOPICS.dispatch}`;
		if (topic !== dispatchTopic) {
			return;
		}

		let payload;
		try {
			payload = JSON.parse(payloadBuffer.toString());
		} catch (error) {
			console.error('[CMD ERROR] Invalid JSON payload:', error.message);
			await this.publishCommandAck({
				status: 'error',
				message: `Invalid JSON payload: ${error.message}`,
				timestamp: new Date().toISOString(),
				handledBy: 'battery-mqtt'
			});
			return;
		}

		await this.handleCommand(payload);
	}

	async poll() {
		if (this.isPolling) {
			console.log('[POLL] Previous cycle still running, skipping this tick');
			return;
		}

		this.isPolling = true;
		try {
			const state = await this.readBatteryState();
			console.log('[DATA]', state);
			await Promise.all([
				this.publishBatteryState(state),
				this.saveBatteryState(state)
			]);
		} catch (error) {
			console.error('[ERROR] Poll cycle failed:', error.message);
		} finally {
			this.isPolling = false;
		}
	}

	async start() {
		try {
			await this.connect();
			await this.subscribeCommandTopics();
			this.controllerInfo = await this.readControllerInfo();
			console.log('[INFO] Controller info:', this.controllerInfo);
			await this.publishControllerInfo();

			this.isRunning = true;
			console.log(`[INFO] Starting polling every ${this.config.pollInterval}ms`);

			await this.poll();
			this.pollTimer = setInterval(async () => {
				await this.poll();
			}, this.config.pollInterval);

			process.on('SIGINT', async () => {
				console.log('\n[INFO] Shutting down gracefully...');
				await this.stop();
				process.exit(0);
			});
			process.on('SIGTERM', async () => {
				console.log('\n[INFO] Shutting down gracefully...');
				await this.stop();
				process.exit(0);
			});
		} catch (error) {
			console.error('[FATAL] Failed to start:', error.message);
			process.exit(1);
		}
	}

	async stop() {
		this.isRunning = false;

		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}

		if (this.mqttClient) {
			await this.mqttClient.endAsync();
		}

		if (this.modbusClient) {
			this.modbusClient.close(() => {
				console.log('[✓] Modbus closed');
			});
		}

		console.log('[✓] Shutdown complete');
	}
}

const bridge = new BatteryBridge(CONFIG);
bridge.start().catch((error) => {
	console.error('[FATAL] Unexpected error:', error);
	process.exit(1);
});
