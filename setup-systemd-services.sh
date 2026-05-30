#!/usr/bin/env bash
set -euo pipefail

# Configure these if your setup is different.
PROJECT_DIR="/home/pi/Raspi-MQTT"
SERVICE_USER="pi"
NODE_BIN="$(command -v node || true)"

if [[ -z "${NODE_BIN}" ]]; then
  echo "Error: node not found in PATH. Install Node.js first."
  exit 1
fi

if [[ ! -d "${PROJECT_DIR}" ]]; then
  echo "Error: project directory not found: ${PROJECT_DIR}"
  exit 1
fi

cd "${PROJECT_DIR}"

if [[ ! -f ".env" ]]; then
  echo "Warning: .env not found in ${PROJECT_DIR}."
fi

echo "Using Node binary: ${NODE_BIN}"
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
WorkingDirectory=${PROJECT_DIR}
ExecStart=${NODE_BIN} --env-file=.env labsens-mqtt.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

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
WorkingDirectory=${PROJECT_DIR}
ExecStart=${NODE_BIN} --env-file=.env battery-mqtt.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

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
ExecStart=${NODE_BIN} --env-file=.env battery-cmd-bridge.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

echo "Reloading systemd..."
sudo systemctl daemon-reload

echo "Enabling services at boot..."
sudo systemctl enable raspi-labsens.service
sudo systemctl enable raspi-battery.service
sudo systemctl enable raspi-battery-cmd-bridge.service

echo "Starting services now..."
sudo systemctl start raspi-labsens.service
sudo systemctl start raspi-battery.service
sudo systemctl start raspi-battery-cmd-bridge.service

echo
echo "Done. Current status:"
systemctl --no-pager --full status raspi-labsens.service || true
systemctl --no-pager --full status raspi-battery.service || true
systemctl --no-pager --full status raspi-battery-cmd-bridge.service || true

echo
echo "Useful logs:"
echo "  journalctl -u raspi-labsens.service -f"
echo "  journalctl -u raspi-battery.service -f"
echo "  journalctl -u raspi-battery-cmd-bridge.service -f"
