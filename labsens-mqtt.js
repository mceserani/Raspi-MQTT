import ModbusRTU from 'modbus-serial';
import mqtt from 'mqtt';
import * as mariadb from 'mariadb';
import { findModbusPort, isAutoPort } from './modbus-autodetect.js';

const MQTT_BROKER = process.env.MQTT_BROKER ?? 'mqtt://localhost:1883';
const MQTT_USERNAME = process.env.MQTT_USERNAME;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD;
const MARIADB_HOST = process.env.MARIADB_HOST ?? 'localhost';
const MARIADB_PORT = Number(process.env.MARIADB_PORT ?? 3306);
const MARIADB_USER = process.env.MARIADB_USER ?? 'mceserani';
const MARIADB_PASSWORD = process.env.MARIADB_PASSWORD;
const MARIADB_DATABASE = process.env.MARIADB_DATABASE ?? 'sensor_data';

function parseNumber(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// Configuration
const CONFIG = {
  // Modbus settings
  modbus: {
    // 'auto' (default) scans /dev/serial/by-id; an explicit path is tried first
    port: process.env.LABSENS_MODBUS_PORT ?? 'auto',
    baudRate: parseNumber(process.env.LABSENS_BAUD_RATE, 115200),
    address: parseNumber(process.env.LABSENS_MODBUS_ADDRESS, 29),
    startRegister: 64,
    registerCount: 6,
    timeout: parseNumber(process.env.LABSENS_MODBUS_TIMEOUT, 1000),
    // Consecutive failed polls before re-running port detection
    maxFailures: parseNumber(process.env.LABSENS_MAX_FAILURES, 10)
  },
  // MQTT settings
  mqtt: {
    broker: MQTT_BROKER,
    username: MQTT_USERNAME,
    password: MQTT_PASSWORD,
    baseTopic: 'sensors/lab'
  },
  // MariaDB settings
  mariadb: {
    host: MARIADB_HOST,
    port: MARIADB_PORT,
    user: MARIADB_USER,
    password: MARIADB_PASSWORD,
    database: MARIADB_DATABASE,
    table: process.env.LABSENS_DB_TABLE ?? 'labsens_measurements'
  },
  // Polling interval (milliseconds)
  pollInterval: parseNumber(process.env.LABSENS_POLL_INTERVAL, 1000)
};

// Sensor data mapping
const SENSORS = [
  { register: 64, name: 'temperature', unit: '°C', topic: 'temperature' },
  { register: 65, name: 'humidity', unit: '%', topic: 'humidity' },
  { register: 66, name: 'pm10', unit: 'µg/m³', topic: 'pm10' },
  { register: 67, name: 'pm2_5', unit: 'µg/m³', topic: 'pm2_5' },
  { register: 68, name: 'voc', unit: 'ppb', topic: 'voc' },
  { register: 69, name: 'nox', unit: 'ppb', topic: 'nox' }
];

const NTC_SENSORS = [
  { register: 34, name: 'ntc_temperature', unit: '°C', topic: 'temperature' }
];

// Main bridge class
// This class encapsulates all functionality for connecting to Modbus, MQTT, and MariaDB,
// as well as reading sensor data, publishing to MQTT, and saving to MariaDB.
class LabSensorsBridge {

  constructor(config) {
    this.config = config;
    this.modbusClient = new ModbusRTU();
    this.mqttClient = null;
    this.dbPool = null;
    this.isRunning = false;
    this.isPolling = false;
    this.modbusPort = null;
    this.modbusReconnectPromise = null;
    this.consecutiveFailures = 0;
  }

  // Worst case for readRegistersWithFallback: holding + input request both time out
  get readTimeout() {
    return this.config.modbus.timeout * 2 + 500;
  }

  async openModbus() {
    const { port, address, baudRate, timeout } = this.config.modbus;
    this.modbusPort = await findModbusPort({
      label: 'labsens',
      address,
      baudRate,
      probeRegister: this.config.modbus.startRegister,
      preferredPort: this.modbusPort ?? (isAutoPort(port) ? undefined : port)
    });

    await this.modbusClient.connectRTUBuffered(this.modbusPort, { baudRate });
    this.modbusClient.setID(address);
    this.modbusClient.setTimeout(timeout);
  }

  async setupDatabase() {
    let adminConnection;
    try {
      adminConnection = await mariadb.createConnection({
        host: this.config.mariadb.host,
        port: this.config.mariadb.port,
        user: this.config.mariadb.user,
        password: this.config.mariadb.password
      });

      await adminConnection.query(
        `CREATE DATABASE IF NOT EXISTS ${this.config.mariadb.database}`
      );
    } finally {
      if (adminConnection) {
        await adminConnection.end();
      }
    }

    this.dbPool = mariadb.createPool({
      host: this.config.mariadb.host,
      port: this.config.mariadb.port,
      user: this.config.mariadb.user,
      password: this.config.mariadb.password,
      database: this.config.mariadb.database,
      connectionLimit: 5
    });

    await this.dbPool.query(`
      CREATE TABLE IF NOT EXISTS ${this.config.mariadb.table} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        recorded_at DATETIME(3) NOT NULL,
        temperature DOUBLE,
        humidity DOUBLE,
        pm10 DOUBLE,
        pm2_5 DOUBLE,
        voc DOUBLE,
        nox DOUBLE,
        ntc_temperature DOUBLE,
        PRIMARY KEY (id),
        INDEX idx_recorded_at (recorded_at)
      )
    `);
  }

  async connect() {
    console.log('[INFO] Connecting to Modbus device...');
    try {
      await this.openModbus();
      console.log(`[✓] Modbus connected on ${this.modbusPort}`);
    } catch (error) {
      console.error('[ERROR] Modbus connection failed:', error.message);
      throw error;
    }

    console.log('[INFO] Connecting to MQTT broker...');
    try {
      this.mqttClient = await mqtt.connectAsync(this.config.mqtt.broker, {
        username: this.config.mqtt.username,
        password: this.config.mqtt.password
      });
      this.mqttClient.on('error', (err) => {
        console.error('[ERROR] MQTT error:', err.message);
      });
      console.log('[✓] MQTT connected');
    } catch (error) {
      console.error('[ERROR] MQTT connection failed:', error.message);
      throw error;
    }

    console.log('[INFO] Connecting to MariaDB...');
    try {
      await this.setupDatabase();
      console.log('[✓] MariaDB connected');
    } catch (error) {
      console.error('[ERROR] MariaDB connection failed:', error.message);
      throw error;
    }
  }

  async ensureModbusConnected() {
    if (this.modbusClient?.isOpen) {
      return true;
    }

    // Port detection can outlast a read timeout: share one reconnect between callers
    if (!this.modbusReconnectPromise) {
      this.modbusReconnectPromise = (async () => {
        console.warn('[WARN] Modbus port closed, reconnecting...');
        await this.openModbus();
        console.log(`[✓] Modbus reconnected on ${this.modbusPort}`);
      })().finally(() => {
        this.modbusReconnectPromise = null;
      });
    }

    try {
      await this.modbusReconnectPromise;
      return true;
    } catch (error) {
      console.error('[ERROR] Modbus reconnection failed:', error.message);
      return false;
    }
  }

  async readSensorData() {
    try {
      console.log('[DEBUG] Attempting to read Modbus registers 64-69...');
      const readPromise = this.readRegistersWithFallback(
        this.config.modbus.startRegister,
        this.config.modbus.registerCount,
        'sensor block 64-69'
      );
      
      // Guard against hanging; longer than both fallback requests so none is left pending
      const response = await Promise.race([
        readPromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Modbus read timeout after ${this.readTimeout}ms`)), this.readTimeout)
        )
      ]);
      
      const registers = response.data;
      console.log('[DEBUG] Raw Modbus registers:', registers);

      const sensorValues = {};
      SENSORS.forEach((sensor, index) => {
        // Assuming values are stored as integers or need conversion
        sensorValues[sensor.name] = registers[index] / 100; // Divide by 100 for decimal values
      });

      console.log('[DEBUG] Parsed sensor values:', sensorValues);
      return sensorValues;
    } catch (error) {
      console.error('[ERROR] Failed to read Modbus registers:', error.message);
      console.error('[DEBUG] Stack:', error.stack);
      return null;
    }
  }

  async readNtcData() {
    try {
      console.log('[DEBUG] Attempting to read Modbus register 34 (NTC temperature)...');
      const readPromise = this.readRegistersWithFallback(34, 1, 'NTC block 34');
      const response = await Promise.race([
        readPromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Modbus NTC read timeout after ${this.readTimeout}ms`)), this.readTimeout)
        )
      ]);

      const registers = response.data;
      console.log('[DEBUG] Raw NTC registers:', registers);

      const ntcValues = {
        ntc_temperature: registers[0] / 10
      };
      console.log('[DEBUG] Parsed NTC values:', ntcValues);
      return ntcValues;
    } catch (error) {
      console.error('[ERROR] Failed to read NTC Modbus registers:', error.message);
      console.error('[DEBUG] Stack:', error.stack);
      return null;
    }
  }

  async readRegistersWithFallback(startRegister, count, label) {
    const connected = await this.ensureModbusConnected();
    if (!connected) {
      throw new Error('Modbus port unavailable');
    }

    try {
      const response = await this.modbusClient.readHoldingRegisters(startRegister, count);
      console.log(`[DEBUG] ${label}: readHoldingRegisters OK`);
      return response;
    } catch (holdingError) {
      if (holdingError?.message?.includes('Port Not Open')) {
        const reconnected = await this.ensureModbusConnected();
        if (!reconnected) {
          throw holdingError;
        }
      }

      console.warn(`[WARN] ${label}: readHoldingRegisters failed (${holdingError.message}), trying readInputRegisters...`);
      const response = await this.modbusClient.readInputRegisters(startRegister, count);
      console.log(`[DEBUG] ${label}: readInputRegisters OK`);
      return response;
    }
  }

  async publishToMQTT(sensorValues) {
    try {
      for (const sensor of SENSORS) {
        const topic = `${this.config.mqtt.baseTopic}/${sensor.topic}`;
        const value = sensorValues[sensor.name];
        
        await this.mqttClient.publish(topic, JSON.stringify({
          value: value,
          unit: sensor.unit,
          timestamp: new Date().toISOString(),
          sensor: sensor.name
        }));

        console.log(`[MQTT] Published ${sensor.name}: ${value} ${sensor.unit}`);
      }
    } catch (error) {
      console.error('[ERROR] Failed to publish to MQTT:', error.message);
    }
  }

  async publishNtcToMQTT(ntcValues) {
    try {
      for (const sensor of NTC_SENSORS) {
        const topic = `${this.config.mqtt.baseTopic}/ntc/${sensor.topic}`;
        const value = ntcValues[sensor.name];

        await this.mqttClient.publish(topic, JSON.stringify({
          value: value,
          unit: sensor.unit,
          timestamp: new Date().toISOString(),
          sensor: sensor.name
        }));

        console.log(`[MQTT] Published ${sensor.name}: ${value} ${sensor.unit}`);
      }
    } catch (error) {
      console.error('[ERROR] Failed to publish NTC data to MQTT:', error.message);
    }
  }

  async saveToMariaDB(sensorValues, ntcValues) {
    try {
      const insertSql = `
        INSERT INTO ${this.config.mariadb.table}
        (recorded_at, temperature, humidity, pm10, pm2_5, voc, nox, ntc_temperature)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `;
      await this.dbPool.query(insertSql, [
        new Date(),
        sensorValues.temperature,
        sensorValues.humidity,
        sensorValues.pm10,
        sensorValues.pm2_5,
        sensorValues.voc,
        sensorValues.nox,
        ntcValues.ntc_temperature
      ]);
      console.log(`[MariaDB] Saved row in ${this.config.mariadb.table}`);
    } catch (error) {
      console.error('[ERROR] Failed to save to MariaDB:', error.message);
      console.error('[DEBUG] Stack:', error.stack);
    }
  }

  // After too many failed polls the device may have moved to another adapter:
  // close the port so the next read re-runs port detection.
  async handleReadFailure() {
    this.consecutiveFailures++;
    if (this.consecutiveFailures < this.config.modbus.maxFailures || !this.modbusClient.isOpen) {
      return;
    }

    console.warn(`[WARN] ${this.consecutiveFailures} consecutive read failures, closing ${this.modbusPort} to re-detect the device`);
    this.consecutiveFailures = 0;
    await new Promise((resolve) => this.modbusClient.close(() => resolve()));
  }

  async poll() {
    if (this.isPolling) {
      console.log('[POLL] Previous cycle still running, skipping this tick');
      return;
    }

    this.isPolling = true;
    console.log('[POLL] Reading sensor data...');

    try {
      // Modbus client should be used sequentially to avoid request collisions.
      const sensorValues = await this.readSensorData();
      const ntcValues = await this.readNtcData();

      if (!sensorValues || !ntcValues) {
        console.log('[POLL] Skipping update due to read error (will retry next tick)');
        await this.handleReadFailure();
        return;
      }

      this.consecutiveFailures = 0;

      console.log('[DATA]', { ...sensorValues, ...ntcValues });

      // Publish and persistence can remain parallel.
      await Promise.all([
        this.publishToMQTT(sensorValues),
        this.publishNtcToMQTT(ntcValues),
        this.saveToMariaDB(sensorValues, ntcValues)
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
      this.isRunning = true;
      console.log(`[INFO] Starting polling every ${this.config.pollInterval}ms`);

      // Initial poll
      await this.poll();

      // Setup interval polling
      this.pollInterval = setInterval(async () => {
        await this.poll();
      }, this.config.pollInterval);

      const shutdown = async () => {
        console.log('\n[INFO] Shutting down gracefully...');
        await this.stop();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

    } catch (error) {
      console.error('[FATAL] Failed to start:', error.message);
      process.exit(1);
    }
  }

  async stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }

    if (this.mqttClient) {
      await this.mqttClient.endAsync();
    }

    if (this.modbusClient?.isOpen) {
      this.modbusClient.close(() => {
        console.log('[✓] Modbus closed');
      });
    }

    if (this.dbPool) {
      await this.dbPool.end();
      this.dbPool = null;
      console.log('[✓] MariaDB closed');
    }

    console.log('[✓] Shutdown complete');
  }
}

// Main entry point
if (!CONFIG.mariadb.password) {
  console.error('[FATAL] MARIADB_PASSWORD is not set (add it to .env)');
  process.exit(1);
}

const bridge = new LabSensorsBridge(CONFIG);
bridge.start().catch((error) => {
  console.error('[FATAL] Unexpected error:', error);
  process.exit(1);
});
