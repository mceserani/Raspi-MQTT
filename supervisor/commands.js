import { RUN_STATE_LABELS, SENSOR_INFO } from './rules.js';

export const BOT_COMMANDS = [
	{ command: 'status', description: 'Stato di laboratorio, batteria e servizi' },
	{ command: 'stop', description: 'Ferma subito la batteria' },
	{ command: 'eventi', description: 'Eventi aperti' },
	{ command: 'battery', description: 'Profilo batteria: /battery [nome|auto]' },
	{ command: 'reset', description: 'Riarma l\'interblocco dopo le verifiche' },
	{ command: 'report', description: 'Report dell\'agente: /report [giorno|settimana]' },
	{ command: 'ask', description: 'Domanda all\'agente: /ask <domanda>' },
	{ command: 'help', description: 'Elenco dei comandi' }
];

const LAB_ORDER = ['temperature', 'humidity', 'pm2_5', 'pm10', 'voc', 'nox', 'ntc_temperature'];
const SHORT_LABELS = { temperature: 'T', humidity: 'UR', pm2_5: 'PM2.5', pm10: 'PM10', voc: 'VOC', nox: 'NOx', ntc_temperature: 'NTC' };

function formatDuration(seconds) {
	const s = Math.max(0, Math.round(seconds));
	if (s < 90) return `${s} s`;
	if (s < 5400) return `${Math.round(s / 60)} min`;
	const h = Math.floor(s / 3600);
	const m = Math.round((s % 3600) / 60);
	return h < 48 ? `${h} h ${m} min` : `${Math.floor(h / 24)} g ${h % 24} h`;
}

function round(value) {
	return typeof value === 'number' ? Math.round(value * 10) / 10 : value;
}

export function formatProfile(profile) {
	if (!profile?.name) return 'nessuno → solo osservazione';
	const origin = profile.source === 'manual' ? 'dichiarato' : 'da registro 405';
	return profile.usable
		? `${profile.name} (${origin})`
		: `${profile.name} (${origin}) NON utilizzabile: ${profile.reasons.join(', ')} → solo osservazione`;
}

export function formatStatus(status) {
	const lines = [`🟢 Supervisore attivo da ${formatDuration(status.uptimeSeconds)}`];

	const labEntries = LAB_ORDER.filter((sensor) => status.live.lab[sensor]);
	if (labEntries.length === 0) {
		lines.push('Laboratorio: nessun dato');
	} else {
		const age = Math.max(...labEntries.map((sensor) => status.live.lab[sensor].ageSeconds));
		const values = labEntries.map((sensor) => {
			const entry = status.live.lab[sensor];
			return `${SHORT_LABELS[sensor]} ${round(entry.value)}${entry.invalid ? '?' : ''} ${SENSOR_INFO[sensor].unit}`;
		});
		lines.push(`Laboratorio (${formatDuration(age)} fa): ${values.join(' · ')}`);
	}

	const battery = status.live.battery;
	if (!battery) {
		lines.push('Batteria: nessun dato');
	} else {
		lines.push(`Batteria (${formatDuration(battery.ageSeconds)} fa): ${RUN_STATE_LABELS[battery.runState] ?? battery.runState} · `
			+ `${battery.voltageMeasuredMv} mV / ${battery.currentMeasuredMa} mA `
			+ `(set ${battery.voltageSetpointMv} mV / ${battery.currentSetpointMa} mA) · tipo ${battery.batteryType}`);
	}

	lines.push(`Profilo: ${formatProfile(status.profile)}`);
	lines.push(status.interlock.latched
		? `Interblocco: ⛔ SCATTATO alle ${new Date(status.interlock.latched.at).toLocaleTimeString('it-IT')} (${status.interlock.latched.reasons.join('; ')})`
		: `Interblocco: ${status.profile?.usable ? 'armato' : 'inattivo (nessun profilo utilizzabile)'}`);

	const counts = { critical: 0, warning: 0, info: 0 };
	for (const event of status.openEvents) counts[event.severity]++;
	lines.push(status.openEvents.length === 0
		? 'Eventi aperti: nessuno'
		: `Eventi aperti: ${status.openEvents.length} (🚨 ${counts.critical} · ⚠️ ${counts.warning} · ℹ️ ${counts.info}) → /eventi`);

	if (status.health) {
		const down = Object.entries(status.health.services).filter(([, service]) => service.state !== 'active');
		lines.push(down.length === 0
			? 'Servizi: tutti attivi'
			: `Servizi non attivi: ${down.map(([unit, service]) => `${unit} (${service.state})`).join(', ')}`);
	}

	if (status.agent !== undefined) lines.push(formatAgent(status.agent));
	if (!status.databaseReady) lines.push('⚠️ MariaDB non raggiungibile: eventi in coda');
	return lines.join('\n');
}

export function formatEvents(events, now) {
	if (events.length === 0) return 'Nessun evento aperto.';
	const icons = { info: 'ℹ️', warning: '⚠️', critical: '🚨' };
	return events
		.slice(0, 20)
		.map((event) => `${icons[event.severity]} ${event.message} (da ${formatDuration((now - event.openedAt) / 1000)})`)
		.join('\n');
}

const HELP = BOT_COMMANDS.map((c) => `/${c.command} — ${c.description}`).join('\n');

export function formatAgent(agent) {
	if (!agent?.online) return 'Agente: non attivo';
	const { used, max, sonnetUsed, sonnetMax } = agent.budget ?? {};
	const activity = agent.running ? `al lavoro (${agent.running.kind})` : 'in attesa';
	return `Agente: ${activity}${agent.queued ? `, ${agent.queued} in coda` : ''} · oggi ${used}/${max} esecuzioni (Sonnet ${sonnetUsed}/${sonnetMax})`;
}

// ctx: status(), stop(), openEvents(), profiles(), setManualProfile(name|null), resetInterlock(), askAgent(text), requestReport(period), now()
export function createCommandHandler(ctx) {
	return async (command, args) => {
		switch (command) {
			case 'start':
			case 'help':
				return HELP;

			case 'status':
				return formatStatus(ctx.status());

			case 'stop': {
				const result = await ctx.stop('telegram');
				return result.stopped
					? '🛑 Batteria ferma.'
					: `⚠️ Stop inviato ma non confermato: ${result.message}`;
			}

			case 'eventi':
				return formatEvents(ctx.openEvents(), ctx.now());

			case 'battery': {
				const { names, active, manual } = ctx.profiles();
				if (args.length === 0) {
					return [
						`Profilo attivo: ${formatProfile(active)}`,
						`Dichiarazione manuale: ${manual ?? 'nessuna (si usa il registro 405)'}`,
						`Profili disponibili: ${names.join(', ') || 'nessuno'}`,
						'Uso: /battery <nome> per dichiararlo, /battery auto per tornare al registro'
					].join('\n');
				}
				const name = args[0] === 'auto' ? null : args[0];
				const result = await ctx.setManualProfile(name);
				return result.ok ? `Profilo attivo: ${formatProfile(result.active)}` : result.message;
			}

			case 'reset': {
				if (!ctx.status().interlock.latched) return 'L\'interblocco non è scattato: nulla da riarmare.';
				await ctx.resetInterlock();
				return '🔓 Interblocco riarmato.';
			}

			case 'ask': {
				if (args.length === 0) return 'Uso: /ask <domanda>. Esempio: /ask com\'è andato il PM2.5 nelle ultime 6 ore?';
				const result = await ctx.askAgent(args.join(' '));
				return result.ok ? `🤖 Domanda inviata all'agente.\n${formatAgent(result.agent)}` : `⚠️ ${result.message}`;
			}

			case 'report': {
				const result = await ctx.requestReport(args[0]?.toLowerCase() ?? 'giorno');
				return result.ok ? `🤖 Report chiesto all'agente.\n${formatAgent(result.agent)}` : `⚠️ ${result.message}`;
			}

			default:
				return `Comando sconosciuto: /${command}\n\n${HELP}`;
		}
	};
}
