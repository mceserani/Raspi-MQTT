#!/usr/bin/env bash
set -euo pipefail

# Path of this project on Raspberry
PROJECT_DIR="/home/mceserani/Raspi-MQTT"
SERVICE_USER="mceserani"
NODE_BIN="$(command -v node || true)"

# Use stable serial paths from /dev/serial/by-id
# You can override these by exporting LABSENS_PORT and BATTERY_PORT before running this script.
LABSENS_PORT="${LABSENS_PORT:-}"
BATTERY_PORT="${BATTERY_PORT:-}"

if [[ -z "${NODE_BIN}" ]]; then
	echo "Error: node not found in PATH. Install Node.js first."
	exit 1
fi

if [[ ! -d "${PROJECT_DIR}" ]]; then
	echo "Error: project directory not found: ${PROJECT_DIR}"
	exit 1
fi

if [[ -z "${LABSENS_PORT}" || -z "${BATTERY_PORT}" ]]; then
	echo "Error: LABSENS_PORT and BATTERY_PORT are required."
	echo ""
	echo "Detected stable serial paths:"
	ls -l /dev/serial/by-id || true
	echo ""
	echo "Run again like this:"
	echo "  LABSENS_PORT='/dev/serial/by-id/<LABSENS_DEVICE>' BATTERY_PORT='/dev/serial/by-id/<BATTERY_DEVICE>' ./setup-systemd-services.sh"
	exit 1
fi

if [[ ! -e "${LABSENS_PORT}" ]]; then
	echo "Error: LABSENS_PORT does not exist: ${LABSENS_PORT}"
	exit 1
fi

if [[ ! -e "${BATTERY_PORT}" ]]; then
	echo "Error: BATTERY_PORT does not exist: ${BATTERY_PORT}"
	exit 1
fi

cd "${PROJECT_DIR}"

if [[ ! -f ".env" ]]; then
	echo "Warning: .env not found in ${PROJECT_DIR}."
fi

echo "Using Node binary: ${NODE_BIN}"
echo "Labsens serial: ${LABSENS_PORT}"
echo "Battery serial: ${BATTERY_PORT}"
echo "Installing npm dependencies..."
npm install

echo "Creating raspi-labsens.service..."
sudo tee /etc/systemd/system/raspi-labsens.service > /dev/null <<EOF
[Unit]
Description=Raspi MQTT - Lab Sensors
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=dialout
SupplementaryGroups=dialout
WorkingDirectory=${PROJECT_DIR}
Environment=NODE_ENV=production
Environment=LABSENS_MODBUS_PORT=${LABSENS_PORT}
ExecStartPre=/usr/bin/test -e ${LABSENS_PORT}
ExecStart=${NODE_BIN} --env-file=.env labsens-mqtt.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

echo "Creating raspi-battery.service..."
sudo tee /etc/systemd/system/raspi-battery.service > /dev/null <<EOF
[Unit]
Description=Raspi MQTT - Battery Master
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=dialout
SupplementaryGroups=dialout
WorkingDirectory=${PROJECT_DIR}
Environment=NODE_ENV=production
Environment=BATTERY_MODBUS_PORT=${BATTERY_PORT}
ExecStartPre=/usr/bin/test -e ${BATTERY_PORT}
ExecStart=${NODE_BIN} --env-file=.env battery-mqtt.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

echo "Creating raspi-battery-cmd-bridge.service..."
sudo tee /etc/systemd/system/raspi-battery-cmd-bridge.service > /dev/null <<EOF
[Unit]
Description=Raspi MQTT - Battery Command Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${PROJECT_DIR}
Environment=NODE_ENV=production
ExecStart=${NODE_BIN} --env-file=.env battery-cmd-bridge.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

echo "Reloading systemd..."
sudo systemctl daemon-reload

echo "Enabling services at boot..."
sudo systemctl enable raspi-labsens.service
sudo systemctl enable raspi-battery.service
sudo systemctl enable raspi-battery-cmd-bridge.service

echo "Restarting services now..."
sudo systemctl restart raspi-labsens.service
sudo systemctl restart raspi-battery.service
sudo systemctl restart raspi-battery-cmd-bridge.service

echo
echo "Done. Current status:"
systemctl --no-pager --full status raspi-labsens.service || true
systemctl --no-pager --full status raspi-battery.service || true
systemctl --no-pager --full status raspi-battery-cmd-bridge.service || true

echo
echo "Useful checks:"
echo "  ls -l /dev/serial/by-id"
echo "  journalctl -u raspi-labsens.service -f"
echo "  journalctl -u raspi-battery.service -f"
echo "  journalctl -u raspi-battery-cmd-bridge.service -f"
