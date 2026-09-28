// In-process MQTT broker for development and tests (no Mosquitto needed on the PC).
// Usage: node tools/dev-broker.js [port]
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { Aedes } from 'aedes';

export async function startDevBroker(port = 1883) {
	const broker = await Aedes.createBroker();
	const server = net.createServer(broker.handle);

	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, resolve);
	});

	return {
		port: server.address().port,
		url: `mqtt://localhost:${server.address().port}`,
		async close() {
			await new Promise((resolve) => server.close(() => resolve()));
			await new Promise((resolve) => broker.close(() => resolve()));
		}
	};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const port = Number(process.argv[2] ?? 1883);
	const broker = await startDevBroker(port);
	console.log(`[INFO] Dev MQTT broker listening on ${broker.url}`);

	const shutdown = async () => {
		await broker.close();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}
