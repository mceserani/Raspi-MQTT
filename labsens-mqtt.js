import ModbusRTU from 'modbus-serial';
import mqtt from 'mqtt';
import pkg from 'influx';
const { InfluxDB, Point } = pkg;

// Configuration
const CONFIG = {
  // Modbus settings
  modbus: {
    port: '/dev/ttyUSB0',
    baudRate: 9600,
    address: 29,
    startRegister: 64,
    registerCount: 6
  },
  // MQTT settings
  mqtt: {
    broker: 'mqtt://localhost:1883',
    baseTopic: 'sensors/lab'
  },
  // InfluxDB settings
  influxdb: {
    host: 'localhost',
    port: 8086,
    database: 'sensor_data',
    username: 'influxdb',
    password: 'influxdb'
  },
  // Polling interval (milliseconds)
  pollInterval: 5000
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
  { register: 34, name: 'ntc_temperature', unit: '°C', topic: 'temperature' },
  { register: 35, name: 'ntc_voltage', unit: 'mV', topic: 'voltage' }
];

// Main bridge class
// This class encapsulates all functionality for connecting to Modbus, MQTT, and InfluxDB,
// as well as reading sensor data, publishing to MQTT, and saving to InfluxDB.
class LabSensorsBridge {

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
    this.isRunning = false;
  }

  async connect() {
    console.log('[INFO] Connecting to Modbus device...');
    try {
      await this.modbusClient.connectRTUBuffered(
        this.config.modbus.port,
        { baudRate: this.config.modbus.baudRate }
      );
      this.modbusClient.setID(this.config.modbus.address);
      console.log('[✓] Modbus connected');
    } catch (error) {
      console.error('[ERROR] Modbus connection failed:', error.message);
      throw error;
    }

    console.log('[INFO] Connecting to MQTT broker...');
    try {
      this.mqttClient = await mqtt.connectAsync(this.config.mqtt.broker);
      this.mqttClient.on('error', (err) => {
        console.error('[ERROR] MQTT error:', err.message);
      });
      console.log('[✓] MQTT connected');
    } catch (error) {
      console.error('[ERROR] MQTT connection failed:', error.message);
      throw error;
    }

    console.log('[INFO] Testing InfluxDB connection...');
    try {
      const dbs = await this.influxClient.getDatabaseNames();
      if (!dbs.includes(this.config.influxdb.database)) {
        console.log(`[INFO] Creating InfluxDB database: ${this.config.influxdb.database}`);
        await this.influxClient.createDatabase(this.config.influxdb.database);
      }
      console.log('[✓] InfluxDB connected');
    } catch (error) {
      console.error('[ERROR] InfluxDB connection failed:', error.message);
      throw error;
    }
  }

  async readSensorData() {
    try {
      console.log('[DEBUG] Attempting to read Modbus registers 64-69...');
      const readPromise = this.modbusClient.readHoldingRegisters(
        this.config.modbus.startRegister,
        this.config.modbus.registerCount
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
      const response = await this.modbusClient.readHoldingRegisters(34, 2);
      const registers = response.data;
      console.log('[DEBUG] Raw NTC registers:', registers);

      const ntcValues = {
        ntc_temperature: registers[0] / 10,
        ntc_voltage: registers[1]
      };
      console.log('[DEBUG] Parsed NTC values:', ntcValues);
      return ntcValues;
    } catch (error) {
      console.error('[ERROR] Failed to read NTC Modbus registers:', error.message);
      console.error('[DEBUG] Stack:', error.stack);
      return null;
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

  async saveToInfluxDB(sensorValues) {
    try {
      const points = SENSORS.map(sensor => 
        new Point('sensor_readings')
          .tag('sensor_type', sensor.name)
          .tag('location', 'lab')
          .floatField('value', sensorValues[sensor.name])
          .timestamp(Date.now())
      );

      console.log('[DEBUG] Writing points to InfluxDB:', points.length);
      await this.influxClient.writePoints(points);
      console.log(`[InfluxDB] Saved ${SENSORS.length} data points`);
    } catch (error) {
      console.error('[ERROR] Failed to save to InfluxDB:', error.message);
      console.error('[DEBUG] Stack:', error.stack);
    }
  }

  async saveNtcToInfluxDB(ntcValues) {
    try {
      const points = NTC_SENSORS.map(sensor =>
        new Point('ntc_readings')
          .tag('sensor_type', sensor.name)
          .tag('location', 'lab')
          .floatField('value', ntcValues[sensor.name])
          .timestamp(Date.now())
      );

      console.log('[DEBUG] Writing NTC points to InfluxDB:', points.length);
      await this.influxClient.writePoints(points);
      console.log(`[InfluxDB] Saved ${NTC_SENSORS.length} NTC data points`);
    } catch (error) {
      console.error('[ERROR] Failed to save NTC data to InfluxDB:', error.message);
      console.error('[DEBUG] Stack:', error.stack);
    }
  }

  async poll() {
    console.log('[POLL] Reading sensor data...');
    
    const [sensorValues, ntcValues] = await Promise.all([
      this.readSensorData(),
      this.readNtcData()
    ]);

    if (!sensorValues || !ntcValues) {
      console.log('[POLL] Skipping update due to read error');
      return;
    }

    console.log('[DATA]', { ...sensorValues, ...ntcValues });

    // Publish to MQTT and save both datasets to InfluxDB in parallel
    await Promise.all([
      this.publishToMQTT(sensorValues),
      this.publishNtcToMQTT(ntcValues),
      this.saveToInfluxDB(sensorValues),
      this.saveNtcToInfluxDB(ntcValues)
    ]);
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

    console.log('[✓] Shutdown complete');
  }
}

// Main entry point
const bridge = new LabSensorsBridge(CONFIG);
bridge.start().catch((error) => {
  console.error('[FATAL] Unexpected error:', error);
  process.exit(1);
});
