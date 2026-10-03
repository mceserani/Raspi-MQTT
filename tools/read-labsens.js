// One-off read of the LabSensors board registers, to check what the board
// answers (raw values and documented scale). The serial port is used by
// labsens-mqtt.js: stop it first.
//
// Usage on the Pi:
//   sudo systemctl stop raspi-labsens
//   node --env-file=.env tools/read-labsens.js [readings] [seconds between readings]
//   sudo systemctl start raspi-labsens
import ModbusRTU from 'modbus-serial';
import { findModbusPort, isAutoPort } from '../modbus-autodetect.js';

// Registers and formats from scuole_labs_docs/Registri schede.xlsx (LabSensors)
const BLOCKS = [
	{ start: 34, fields: [{ name: 'NTC1 temperatura', scale: 10, signed: true, unit: '°C' }] },
	{
		start: 64,
		fields: [
			{ name: 'SEN55 temperatura', scale: 100, signed: true, unit: '°C' },
			{ name: 'SEN55 umidità', scale: 100, unit: '%' },
			{ name: 'SEN55 PM10', scale: 10, unit: 'µg/m³' },
			{ name: 'SEN55 PM2.5', scale: 10, unit: 'µg/m³' },
			{ name: 'SEN55 VOC', scale: 1, unit: 'indice' },
			{ name: 'SEN55 NOx', scale: 1, unit: 'indice' }
		]
	},
	{
		start: 80,
		fields: [
			{ name: 'SCD30 temperatura', scale: 100, signed: true, unit: '°C' },
			{ name: 'SCD30 umidità', scale: 100, unit: '%' },
			{ name: 'SCD30 CO2', scale: 1, unit: 'ppm' }
		]
	}
];

const readings = Number(process.argv[2] ?? 5);
const pauseMs = Number(process.argv[3] ?? 2) * 1000;
const address = Number(process.env.LABSENS_MODBUS_ADDRESS ?? 29);
const baudRate = Number(process.env.LABSENS_BAUD_RATE ?? 115200);
const configuredPort = process.env.LABSENS_MODBUS_PORT ?? 'auto';

const toSigned = (raw) => (raw >= 0x8000 ? raw - 0x10000 : raw);

const client = new ModbusRTU();
const port = await findModbusPort({
	label: 'labsens',
	address,
	baudRate,
	probeRegister: 64,
	preferredPort: isAutoPort(configuredPort) ? undefined : configuredPort
});
await client.connectRTUBuffered(port, { baudRate });
client.setID(address);
client.setTimeout(1000);
console.log(`Scheda LabSensors su ${port}, indirizzo ${address}`);

for (let i = 0; i < readings; i++) {
	console.log(`\nLettura ${i + 1}/${readings} (${new Date().toLocaleTimeString('it-IT')})`);
	for (const block of BLOCKS) {
		const last = block.start + block.fields.length - 1;
		try {
			const { data } = await client.readHoldingRegisters(block.start, block.fields.length);
			block.fields.forEach((field, k) => {
				const raw = data[k];
				const value = (field.signed ? toSigned(raw) : raw) / field.scale;
				console.log(`  ${String(block.start + k).padStart(3)}  ${field.name.padEnd(18)} grezzo ${String(raw).padStart(5)}  →  ${value} ${field.unit}`);
			});
		} catch (error) {
			console.log(`  ${block.start}-${last}  lettura non riuscita: ${error.message}`);
		}
	}
	if (i < readings - 1) await new Promise((resolve) => setTimeout(resolve, pauseMs));
}

client.close(() => {});
