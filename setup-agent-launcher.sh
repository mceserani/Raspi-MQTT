#!/usr/bin/env bash
# Installs raspi-agent-launcher.service (docs/PIANO-AGENTE.md, phase 3a): runs
# Claude Code as raspi-agent on the jobs sent by the supervisor (/ask), one at
# a time and within the daily budget of config/agent.json.
# It first refreshes the code in /opt/raspi-agent with setup-agent-mcp.sh.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_USER="raspi-agent"
AGENT_HOME="/home/${AGENT_USER}"
AGENT_ENV="${AGENT_HOME}/.config/raspi-agent/agent.env"
INSTALL_DIR="/opt/raspi-agent"
CLAUDE_BIN="${AGENT_HOME}/.local/bin/claude"

cd "${PROJECT_DIR}"
# The service is (re)started below: no restart inside setup-agent-mcp.sh
RASPI_AGENT_NO_RESTART=1 ./setup-agent-mcp.sh

if ! sudo test -x "${CLAUDE_BIN}"; then
	echo "Error: Claude Code not found in ${CLAUDE_BIN}. Run: ./setup-agent-prereqs.sh --install-claude"
	exit 1
fi
if ! sudo grep -qE '^CLAUDE_CODE_OAUTH_TOKEN=.+' "${AGENT_ENV}"; then
	echo "Error: CLAUDE_CODE_OAUTH_TOKEN is empty in ${AGENT_ENV}."
	exit 1
fi

NODE_BIN="$(readlink -f "$(command -v node)")"
# Created as the agent user: Claude Code also keeps its own state in ~/.local/state
(cd / && sudo -u "${AGENT_USER}" mkdir -p "${AGENT_HOME}/.local/state/raspi-agent")

./setup-agent-journal.sh

echo "Creating raspi-agent-launcher.service..."
sudo tee /etc/systemd/system/raspi-agent-launcher.service > /dev/null <<UNIT
[Unit]
Description=Raspi MQTT - Agent launcher (Claude Code, daily budget)
After=network-online.target mosquitto.service raspi-supervisor.service
Wants=network-online.target

[Service]
Type=simple
User=${AGENT_USER}
Group=${AGENT_USER}
WorkingDirectory=${AGENT_HOME}/workspace
EnvironmentFile=${AGENT_ENV}
ExecStart=${NODE_BIN} ${INSTALL_DIR}/agent/launcher.js
Restart=always
RestartSec=10
NoNewPrivileges=true
# Own persistent journal (setup-agent-journal.sh)
LogNamespace=raspi-agent

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable raspi-agent-launcher.service
sudo systemctl restart raspi-agent-launcher.service

echo
systemctl --no-pager --full status raspi-agent-launcher.service || true

echo
echo "Useful checks:"
echo "  journalctl --namespace=raspi-agent -u raspi-agent-launcher -f"
echo "  From Telegram: /status (line 'Agente: in attesa …'), then /ask <domanda>"
echo "  Budget: edit config/agent.json (launcher), then ./setup-agent-mcp.sh (it restarts the launcher)"
