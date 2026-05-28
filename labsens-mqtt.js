import ModbusRTU from 'modbus-serial';
import mqtt from 'mqtt';
import * as mariadb from 'mariadb';

const MQTT_BROKER = process.env.MQTT_BROKER ?? 'mqtt://localhost:1883';
const MQTT_USERNAME = process.env.MQTT_USERNAME;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD;
const MARIADB_HOST = process.env.MARIADB_HOST ?? 'localhost';
const MARIADB_PORT = Number(process.env.MARIADB_PORT ?? 3306);
const MARIADB_USER = process.env.MARIADB_USER ?? 'root';
const MARIADB_PASSWORD = process.env.MARIADB_PASSWORD ?? '';
const MARIADB_DATABASE = process.env.MARIADB_DATABASE ?? 'sensor_data';

// Configuration
const CONFIG = {
  // Modbus settings
  modbus: {
    port: '/dev/ttyUSB0',
    baudRate: 115200,
    address: 29,
    startRegister: 64,
    registerCount: 6
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
  pollInterval: 1000
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
      await this.modbusClient.connectRTUBuffered(
        this.config.modbus.port,
        { baudRate: this.config.modbus.baudRate }
      );
      this.modbusClient.setID(this.config.modbus.address);
      this.modbusClient.setTimeout(4000);
      console.log('[✓] Modbus connected');
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

  async readSensorData() {
    try {
      console.log('[DEBUG] Attempting to read Modbus registers 64-69...');
      const readPromise = this.readRegistersWithFallback(
        this.config.modbus.startRegister,
        this.config.modbus.registerCount,
        'sensor block 64-69'
      );
      
      // Add 5-second timeout to prevent infinite hanging
      const response = await Promise.race([
        readPromise,
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Modbus read timeout after 5s')), 5000)
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
          setTimeout(() => reject(new Error('Modbus NTC read timeout after 5s')), 5000)
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
        return;
      }

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

      process.on('SIGINT', async () => {
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
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }

    if (this.mqttClient) {
      await this.mqttClient.endAsync();
    }

    if (this.modbusClient) {
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
const bridge = new LabSensorsBridge(CONFIG);
bridge.start().catch((error) => {
  console.error('[FATAL] Unexpected error:', error);
  process.exit(1);
});
