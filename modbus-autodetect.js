import { readdir } from 'node:fs/promises';
import ModbusRTU from 'modbus-serial';

const SERIAL_BY_ID_DIR = '/dev/serial/by-id';

// Values of *_MODBUS_PORT that mean "find the device automatically"
export function isAutoPort(port) {
	return !port || port.toLowerCase() === 'auto';
}

function shuffle(items) {
	for (let i = items.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[items[i], items[j]] = [items[j], items[i]];
	}
	return items;
}

async function listSerialPorts() {
	try {
		const entries = await readdir(SERIAL_BY_ID_DIR);
		return entries.map((entry) => `${SERIAL_BY_ID_DIR}/${entry}`);
	} catch {
		return [];
	}
}

function closeClient(client) {
	return new Promise((resolve) => {
		if (!client.isOpen) {
			resolve();
			return;
		}
		client.close(() => resolve());
	});
}

// Opens `port` and checks that the device with `address` answers on `probeRegister`.
// Returns true/false; a port locked by another process counts as "busy".
async function probePort(port, { address, baudRate, probeRegister, timeout }) {
	const client = new ModbusRTU();
	try {
		await client.connectRTUBuffered(port, { baudRate });
	} catch (error) {
		return { found: false, busy: true, reason: error.message };
	}

	try {
		client.setID(address);
		client.setTimeout(timeout);
		try {
			await client.readHoldingRegisters(probeRegister, 1);
		} catch (error) {
			// Silence means no device with this address; any other error
			// (e.g. a Modbus exception) means the device is there
			if (error.errno === 'ETIMEDOUT') {
				throw error;
			}
			await client.readInputRegisters(probeRegister, 1);
		}
		return { found: true };
	} catch (error) {
		return { found: false, busy: false, reason: error.message };
	} finally {
		await closeClient(client);
	}
}

// Scans /dev/serial/by-id (trying `preferredPort` first) until the Modbus device
// with `address` answers. Retries for a while because another service may be
// holding a port (serial ports are opened with an exclusive lock). Port order and
// retry delay are randomized so that two services starting together don't keep
// probing each other's port in lockstep.
export async function findModbusPort({
	label,
	address,
	baudRate,
	probeRegister,
	preferredPort,
	timeout = 500,
	attempts = 10,
	retryDelay = 2000
}) {
	for (let attempt = 1; attempt <= attempts; attempt++) {
		const ports = shuffle(await listSerialPorts());
		if (preferredPort && !isAutoPort(preferredPort)) {
			ports.sort((a, b) => (a === preferredPort ? -1 : b === preferredPort ? 1 : 0));
		}

		for (const port of ports) {
			const result = await probePort(port, { address, baudRate, probeRegister, timeout });
			if (result.found) {
				console.log(`[AUTODETECT] ${label}: device ${address} found on ${port}`);
				return port;
			}
			console.log(`[AUTODETECT] ${label}: ${port} ${result.busy ? 'busy' : 'no answer'} (${result.reason})`);
		}

		console.warn(`[AUTODETECT] ${label}: device ${address} not found (attempt ${attempt}/${attempts})`);
		if (attempt < attempts) {
			const delay = retryDelay * (0.5 + Math.random());
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}

	throw new Error(`${label}: Modbus device ${address} not found on any serial port in ${SERIAL_BY_ID_DIR}`);
}
