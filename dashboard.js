import mqtt from 'mqtt';

// ─── Configuration ────────────────────────────────────────────────────────────
const BROKER   = 'mqtt://localhost:1883';
const BASE_TOPIC = 'sensors/lab/#';

// Sensor display definitions (order = display order)
const SENSOR_DEFS = [
  { key: 'temperature',     label: 'Temperature',     unit: '°C',     min: -10,  max: 60,   decimals: 2 },
  { key: 'humidity',        label: 'Humidity',        unit: '%',      min: 0,    max: 100,  decimals: 2 },
  { key: 'pm10',            label: 'PM10',            unit: 'µg/m³',  min: 0,    max: 500,  decimals: 2 },
  { key: 'pm2_5',           label: 'PM2.5',           unit: 'µg/m³',  min: 0,    max: 300,  decimals: 2 },
  { key: 'voc',             label: 'VOC',             unit: 'ppb',    min: 0,    max: 1000, decimals: 2 },
  { key: 'nox',             label: 'NOx',             unit: 'ppb',    min: 0,    max: 1000, decimals: 2 },
  { key: 'ntc/temperature', label: 'NTC Temp',        unit: '°C',     min: -10,  max: 60,   decimals: 1 },
  { key: 'ntc/voltage',     label: 'NTC Voltage',     unit: 'mV',     min: 0,    max: 5000, decimals: 0 },
];

// ─── ANSI helpers ─────────────────────────────────────────────────────────────
const ESC = '\x1b';
const ansi = {
  reset:     `${ESC}[0m`,
  bold:      `${ESC}[1m`,
  dim:       `${ESC}[2m`,
  cyan:      `${ESC}[36m`,
  green:     `${ESC}[32m`,
  yellow:    `${ESC}[33m`,
  red:       `${ESC}[31m`,
  blue:      `${ESC}[34m`,
  magenta:   `${ESC}[35m`,
  white:     `${ESC}[97m`,
  bgBlue:    `${ESC}[44m`,
  bgDark:    `${ESC}[40m`,
  clear:     `${ESC}[2J${ESC}[H`,
  hideCursor:`${ESC}[?25l`,
  showCursor:`${ESC}[?25h`,
};

// ─── Dashboard state ──────────────────────────────────────────────────────────
const state = {};          // key → { value, unit, timestamp, stale }
let lastMessage = null;    // ISO timestamp of last received message
let msgCount    = 0;
let connected   = false;

// ─── Bar chart helper (14 chars wide) ────────────────────────────────────────
const BAR_WIDTH = 20;
function renderBar(value, min, max) {
  const pct   = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const filled = Math.round(pct * BAR_WIDTH);
  const color  = pct < 0.5 ? ansi.green : pct < 0.8 ? ansi.yellow : ansi.red;
  return color + '█'.repeat(filled) + ansi.dim + '░'.repeat(BAR_WIDTH - filled) + ansi.reset;
}

// ─── Pad / truncate a string to exact length ──────────────────────────────────
function pad(str, len, right = false) {
  const s = String(str);
  if (right) return s.padStart(len).slice(-len);
  return s.padEnd(len).slice(0, len);
}

// ─── Render the full dashboard ────────────────────────────────────────────────
function render() {
  const now     = new Date().toLocaleTimeString('it-IT');
  const connStr = connected
    ? `${ansi.green}● CONNECTED${ansi.reset}`
    : `${ansi.red}○ DISCONNECTED${ansi.reset}`;

  const lines = [];

  // Header
  lines.push(ansi.bgBlue + ansi.bold + ansi.white
    + '  LAB SENSOR DASHBOARD  '
    + `${pad('', 36)}${now}  `
    + ansi.reset);
  lines.push(`  Broker: ${ansi.cyan}${BROKER}${ansi.reset}   Status: ${connStr}   Messages received: ${ansi.bold}${msgCount}${ansi.reset}`);
  lines.push(ansi.dim + '─'.repeat(75) + ansi.reset);

  // Column headers
  lines.push(
    ansi.bold +
    pad('  Sensor', 20) +
    pad('Value', 14, true) + '  ' +
    pad('Unit', 8) +
    'Bar (min→max)              ' +
    pad('Last update', 12) +
    ansi.reset
  );
  lines.push(ansi.dim + '─'.repeat(75) + ansi.reset);

  // Sensor rows
  for (const def of SENSOR_DEFS) {
    const entry = state[def.key];
    if (!entry) {
      lines.push(
        ansi.dim +
        pad(`  ${def.label}`, 20) +
        pad('—', 14, true) + '  ' +
        pad(def.unit, 8) +
        pad('waiting for data…', 26) +
        pad('', 12) +
        ansi.reset
      );
      continue;
    }

    // Mark stale if last update > 3× poll interval (15 s)
    const age = Date.now() - new Date(entry.timestamp).getTime();
    const isStale = age > 15000;

    const valueStr  = entry.value.toFixed(def.decimals);
    const timeStr   = new Date(entry.timestamp).toLocaleTimeString('it-IT');
    const staleFlag = isStale ? ` ${ansi.yellow}(stale)${ansi.reset}` : '';
    const valueColor = isStale ? ansi.dim : ansi.white + ansi.bold;

    lines.push(
      ansi.cyan + pad(`  ${def.label}`, 20) + ansi.reset +
      valueColor + pad(valueStr, 14, true) + ansi.reset + '  ' +
      ansi.dim + pad(def.unit, 8) + ansi.reset +
      renderBar(entry.value, def.min, def.max) + '  ' +
      ansi.dim + timeStr + staleFlag + ansi.reset
    );
  }

  lines.push(ansi.dim + '─'.repeat(75) + ansi.reset);
  lines.push(`${ansi.dim}  Press Ctrl+C to exit${ansi.reset}`);

  process.stdout.write(ansi.clear + lines.join('\n') + '\n');
}

// ─── MQTT connection ──────────────────────────────────────────────────────────
console.log(ansi.hideCursor);
process.stdout.write(ansi.clear + `${ansi.cyan}Connecting to ${BROKER}…${ansi.reset}\n`);

const client = mqtt.connect(BROKER, {
  clientId: `lab-dashboard-${Math.random().toString(16).slice(2, 8)}`,
  clean: true,
  reconnectPeriod: 3000,
});

client.on('connect', () => {
  connected = true;
  client.subscribe(BASE_TOPIC, { qos: 1 }, (err) => {
    if (err) {
      process.stderr.write(`[ERROR] Subscribe failed: ${err.message}\n`);
    }
  });
  render();
});

client.on('reconnect', () => { connected = false; render(); });
client.on('offline',   () => { connected = false; render(); });
client.on('error',     (err) => { connected = false; render(); });

client.on('message', (topic, payload) => {
  // topic format: sensors/lab/<key>  or  sensors/lab/ntc/<key>
  const key = topic.replace('sensors/lab/', '');  // e.g. "temperature" or "ntc/temperature"

  try {
    const data = JSON.parse(payload.toString());
    if (typeof data.value === 'number') {
      state[key] = {
        value:     data.value,
        unit:      data.unit ?? '',
        timestamp: data.timestamp ?? new Date().toISOString(),
      };
      msgCount++;
      lastMessage = new Date().toISOString();
      render();
    }
  } catch {
    // ignore malformed messages
  }
});

// Refresh every second to update stale markers even without new messages
setInterval(render, 1000);

// ─── Graceful exit ────────────────────────────────────────────────────────────
function shutdown() {
  client.end(true, () => {
    process.stdout.write(ansi.showCursor + ansi.clear);
    process.exit(0);
  });
}

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
