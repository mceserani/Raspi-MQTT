#!/usr/bin/env bash
# Installs raspi-supervisor.service (docs/PIANO-AGENTE.md, 5.1).
# Separate from setup-systemd-services.sh: the existing services are not touched.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_USER="${SERVICE_USER:-$(stat -c '%U' "${PROJECT_DIR}")}"
NODE_BIN="$(command -v node || true)"

if [[ -z "${NODE_BIN}" ]]; then
	echo "Error: node not found in PATH. Install Node.js first."
	exit 1
fi

cd "${PROJECT_DIR}"

if [[ ! -f ".env" ]]; then
	echo "Error: .env not found in ${PROJECT_DIR}."
	exit 1
fi

if ! grep -q '^MARIADB_PASSWORD=' .env; then
	echo "Error: MARIADB_PASSWORD is missing from .env."
	exit 1
fi

for key in TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID; do
	if ! grep -qE "^${key}=.+" .env; then
		echo "Warning: ${key} not set in .env (Telegram disabled or chat not authorized yet)."
	fi
done

echo "Service user: ${SERVICE_USER}"
echo "Using Node binary: ${NODE_BIN}"
echo "Installing npm dependencies..."
npm install --omit=dev

echo "Checking configuration files..."
"${NODE_BIN}" --input-type=module -e "
import { loadProfiles } from './lib/battery-profiles.js';
import { loadSupervisorConfig } from './supervisor/config.js';
await loadProfiles('config/battery-profiles.json');
await loadSupervisorConfig('config/supervisor.json');
console.log('Configuration OK');
"

echo "Creating raspi-supervisor.service..."
sudo tee /etc/systemd/system/raspi-supervisor.service > /dev/null <<EOF
[Unit]
Description=Raspi MQTT - Supervisor (rules, interlock, aggregations, Telegram)
After=network-online.target mariadb.service mosquitto.service
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
# systemd-journal: read access to the journal for the error counters
SupplementaryGroups=systemd-journal
WorkingDirectory=${PROJECT_DIR}
Environment=NODE_ENV=production
ExecStart=${NODE_BIN} --env-file=.env supervisor/index.js
# systemctl reload re-reads config/battery-profiles.json
ExecReload=/bin/kill -HUP \$MAINPID
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

echo "Reloading systemd..."
sudo systemctl daemon-reload
sudo systemctl enable raspi-supervisor.service
sudo systemctl restart raspi-supervisor.service

echo
systemctl --no-pager --full status raspi-supervisor.service || true

echo
echo "Useful checks:"
echo "  journalctl -u raspi-supervisor.service -f"
echo "  mosquitto_sub -t supervisor/status -C 1 | python3 -m json.tool"
echo "  sudo systemctl reload raspi-supervisor   # after editing config/battery-profiles.json"
