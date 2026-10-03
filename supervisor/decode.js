// Until 2026-10-03 labsens-mqtt.js divided unsigned registers, so negative
// temperatures came out as ~655 °C (/100) or ~6553 °C (/10). It now decodes the
// sign itself; this stays for safety (a real temperature above 327 °C is not
// plausible). Only the temperatures can be negative.
const SIGNED_LAB_FIELDS = {
	temperature: 100,
	ntc_temperature: 10
};

export const LAB_METRICS = ['temperature', 'humidity', 'pm10', 'pm2_5', 'voc', 'nox', 'ntc_temperature', 'co2'];

export function decodeLabValue(sensor, value) {
	const divisor = SIGNED_LAB_FIELDS[sensor];
	if (!divisor || typeof value !== 'number' || !Number.isFinite(value)) {
		return value;
	}

	const raw = Math.round(value * divisor);
	return raw >= 0x8000 ? (raw - 0x10000) / divisor : value;
}

// Sensor name of a lab MQTT message: the payload carries it, the topic is the fallback.
export function labSensorName(topic, payload) {
	if (typeof payload?.sensor === 'string') {
		return payload.sensor;
	}

	const suffix = topic.split('/').slice(2).join('/');
	return suffix === 'ntc/temperature' ? 'ntc_temperature' : suffix;
}
