#!/usr/bin/env bash
# Separate, persistent journal for raspi-supervisor and raspi-agent-launcher
# (LogNamespace=raspi-agent in their units). The default journal is kept in RAM
# and the [DEBUG] lines of the existing services fill it within an hour; these
# two services log little, so days of history fit in a small disk quota.
# Read with: journalctl --namespace=raspi-agent -u raspi-supervisor
set -euo pipefail

NAMESPACE="raspi-agent"
MAX_USE="${RASPI_AGENT_JOURNAL_MAX:-200M}"

echo "Configuring the ${NAMESPACE} journal (persistent, max ${MAX_USE})..."
sudo tee "/etc/systemd/journald@${NAMESPACE}.conf" > /dev/null <<CONF
[Journal]
Storage=persistent
SystemMaxUse=${MAX_USE}
CONF

# Picked up by the namespace instance at its next start
if systemctl is-active --quiet "systemd-journald@${NAMESPACE}.service"; then
	sudo systemctl restart "systemd-journald@${NAMESPACE}.service"
fi
