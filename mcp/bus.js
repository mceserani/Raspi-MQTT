import { randomUUID } from 'node:crypto';
import mqtt from 'mqtt';

// MQTT side of the MCP server: keeps the last supervisor/status, sends battery
// commands on the same path as the remote dashboard (request -> bridge ->
// dispatch -> ack) and hands Telegram messages and audit records to the supervisor.
export class Bus {
	constructor(env, { log = console, now = () => Date.now() } = {}) {
		this.env = env;
		this.log = log;
		this.now = now;
		this.status = null;
		this.statusReceivedAt = null;
		this.pendingAcks = new Map();
		this.pendingReplies = new Map();
		this.topics = {
			status: env.statusTopic,
			request: `${env.batteryTopic}/command/request`,
			ack: `${env.batteryTopic}/command/ack`,
			telegram: `${env.agentTopic}/telegram`,
			audit: `${env.agentTopic}/audit`,
			escalate: `${env.agentTopic}/escalate`,
			procedure: `${env.agentTopic}/procedure`,
			procedureReply: `${env.agentTopic}/procedure_reply`
		};
	}

	connect() {
		this.client = mqtt.connect(this.env.mqtt.broker, {
			clientId: `raspi-agent-mcp-${Math.random().toString(16).slice(2, 8)}`,
			username: this.env.mqtt.username,
			password: this.env.mqtt.password,
			reconnectPeriod: 3000,
			connectTimeout: 5000
		});

		this.client.on('connect', () => {
			this.client.subscribe([this.topics.status, this.topics.ack, this.topics.procedureReply], { qos: 1 }, (error) => {
				if (error) this.log.error('[ERROR] MQTT subscribe failed:', error.message);
			});
		});
		this.client.on('error', (error) => this.log.error('[ERROR] MQTT error:', error.message));
		this.client.on('message', (topic, payload) => this.onMessage(topic, payload));
	}

	onMessage(topic, payloadBuffer) {
		let payload;
		try {
			payload = JSON.parse(payloadBuffer.toString());
		} catch {
			return;
		}

		if (topic === this.topics.status) {
			this.status = payload;
			this.statusReceivedAt = this.now();
		} else if (topic === this.topics.ack && payload.commandId && this.pendingAcks.has(payload.commandId)) {
			this.pendingAcks.get(payload.commandId)(payload);
		} else if (topic === this.topics.procedureReply && this.pendingReplies.has(payload.requestId)) {
			this.pendingReplies.get(payload.requestId)(payload);
		}
	}

	get connected() {
		return Boolean(this.client?.connected);
	}

	// The status is retained: right after the start it arrives within moments
	async getStatus(waitSeconds) {
		const deadline = this.now() + waitSeconds * 1000;
		while (!this.status && this.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return { status: this.status, receivedAt: this.statusReceivedAt };
	}

	// Publishes the command and waits for its ack; resolves { ack } or { timeout: true }
	async sendBatteryCommand({ command, value, reason }, timeoutSeconds) {
		if (!this.connected) {
			throw new Error('broker MQTT non connesso');
		}
		const commandId = `agent-${randomUUID()}`;
		const payload = { commandId, command, value, source: 'agent', reason, timestamp: new Date(this.now()).toISOString() };

		const ackPromise = new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pendingAcks.delete(commandId);
				resolve({ commandId, timeout: true });
			}, timeoutSeconds * 1000);
			this.pendingAcks.set(commandId, (ack) => {
				clearTimeout(timer);
				this.pendingAcks.delete(commandId);
				resolve({ commandId, ack });
			});
		});

		await this.client.publishAsync(this.topics.request, JSON.stringify(payload), { qos: 1 });
		return ackPromise;
	}

	async publishToSupervisor(kind, payload) {
		if (!this.connected) {
			throw new Error('broker MQTT non connesso');
		}
		await this.client.publishAsync(this.topics[kind], JSON.stringify({ ...payload, at: new Date(this.now()).toISOString() }), { qos: 1 });
	}

	// Request to the supervisor, answered on <kind>_reply: resolves the reply or { timeout: true }
	async requestSupervisor(kind, payload, timeoutSeconds) {
		if (!this.connected) {
			throw new Error('broker MQTT non connesso');
		}
		const requestId = randomUUID();
		const reply = new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pendingReplies.delete(requestId);
				resolve({ timeout: true });
			}, timeoutSeconds * 1000);
			this.pendingReplies.set(requestId, (message) => {
				clearTimeout(timer);
				this.pendingReplies.delete(requestId);
				resolve(message);
			});
		});
		await this.client.publishAsync(this.topics[kind], JSON.stringify({ ...payload, requestId, at: new Date(this.now()).toISOString() }), { qos: 1 });
		return reply;
	}

	async close() {
		await this.client?.endAsync();
	}
}
