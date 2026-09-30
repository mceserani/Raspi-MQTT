#!/usr/bin/env bash
# Installs the agent's MCP server and launcher code (docs/PIANO-AGENTE.md, phases 2-3) in /opt/raspi-agent.
# The copy belongs to root: the raspi-agent user can run it but not change it,
# and it cannot read the project's .env (Telegram token, main DB password).
# Run it again after every "git pull" that touches mcp/, agent/ or config/agent.json
# (then: sudo systemctl restart raspi-agent-launcher).
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_USER="raspi-agent"
AGENT_HOME="/home/${AGENT_USER}"
AGENT_CONFIG_DIR="${AGENT_HOME}/.config/raspi-agent"
AGENT_ENV="${AGENT_CONFIG_DIR}/agent.env"
MCP_CONFIG="${AGENT_CONFIG_DIR}/mcp.json"
INSTALL_DIR="/opt/raspi-agent"

cd "${PROJECT_DIR}"

if ! id "${AGENT_USER}" &>/dev/null || ! sudo test -f "${AGENT_ENV}"; then
	echo "Error: run ./setup-agent-prereqs.sh first (user ${AGENT_USER} and ${AGENT_ENV})."
	exit 1
fi

if [[ ! -d node_modules/@modelcontextprotocol/sdk ]]; then
	echo "Error: MCP SDK missing. Run: npm install"
	exit 1
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "${NODE_BIN}" ]]; then
	echo "Error: node not found."
	exit 1
fi
NODE_BIN="$(readlink -f "${NODE_BIN}")"
if ! sudo -u "${AGENT_USER}" test -x "${NODE_BIN}"; then
	echo "Error: ${AGENT_USER} cannot run ${NODE_BIN} (Node installed in a private home, e.g. nvm?)."
	echo "Install Node system-wide (e.g. NodeSource packages in /usr/bin) and run again."
	exit 1
fi

# ─── 1. Copy the server (root-owned, read-only for the agent) ──────────────
echo "[+] Installing the MCP server in ${INSTALL_DIR}"
STAGING="$(mktemp -d)"
trap 'rm -rf "${STAGING}"' EXIT
mkdir -p "${STAGING}/config" "${STAGING}/tools"
cp -a mcp agent package.json node_modules "${STAGING}/"
cp config/agent.json "${STAGING}/config/"
cp tools/mcp-call.js "${STAGING}/tools/"

sudo rm -rf "${INSTALL_DIR}.new"
sudo cp -a "${STAGING}" "${INSTALL_DIR}.new"
sudo chown -R root:root "${INSTALL_DIR}.new"
sudo chmod -R u=rwX,go=rX "${INSTALL_DIR}.new"
sudo rm -rf "${INSTALL_DIR}.old"
if [[ -d "${INSTALL_DIR}" ]]; then sudo mv "${INSTALL_DIR}" "${INSTALL_DIR}.old"; fi
sudo mv "${INSTALL_DIR}.new" "${INSTALL_DIR}"
sudo rm -rf "${INSTALL_DIR}.old"

# ─── 2. MCP configuration for Claude Code ──────────────────────────────────
echo "[+] Writing ${MCP_CONFIG}"
sudo tee "${MCP_CONFIG}" > /dev/null <<EOF
{
  "mcpServers": {
    "raspi": {
      "command": "${NODE_BIN}",
      "args": ["--env-file=${AGENT_ENV}", "${INSTALL_DIR}/mcp/server.js"]
    }
  }
}
EOF
sudo chown "root:${AGENT_USER}" "${MCP_CONFIG}"
sudo chmod 640 "${MCP_CONFIG}"

# ─── 3. Smoke test as the agent user (0 tokens) ────────────────────────────
echo "[?] Calling get_service_health as ${AGENT_USER}..."
if sudo -u "${AGENT_USER}" -H "${NODE_BIN}" --env-file="${AGENT_ENV}" "${INSTALL_DIR}/tools/mcp-call.js" get_service_health; then
	echo "[✓] MCP server working"
else
	echo "[!] The call failed: see the message above (is raspi-supervisor running?)"
fi

echo
echo "Test a tool (0 tokens):"
echo "  sudo -u ${AGENT_USER} -H ${NODE_BIN} --env-file=${AGENT_ENV} ${INSTALL_DIR}/tools/mcp-call.js get_live_status"
echo "Test with Claude (uses the subscription):"
echo "  sudo -u ${AGENT_USER} -H bash -c 'set -a; . ${AGENT_ENV}; cd ~/workspace; ~/.local/bin/claude -p \"Usa get_live_status e riassumi lo stato in 3 righe\" --model haiku --mcp-config ${MCP_CONFIG} --strict-mcp-config --allowedTools mcp__raspi__get_live_status'"
