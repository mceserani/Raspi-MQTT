# Server MCP dell'agente

La "dashboard per agenti" (vedi [PIANO-AGENTE.md](PIANO-AGENTE.md), §5.5): gli strumenti con cui l'agente legge i dati e agisce. Claude Code lo avvia via stdio come utente `raspi-agent`, con le credenziali di `agent.env` (MariaDB **read-only**, MQTT). Il token del bot Telegram non gli arriva mai: i messaggi passano dal supervisore.

## Installazione sul Pi

```bash
cd ~/Raspi-MQTT && git pull && npm install
sudo systemctl restart raspi-supervisor   # serve il supervisore aggiornato (messaggi dell'agente)
./setup-agent-mcp.sh
```

Lo script copia il server in `/opt/raspi-agent` (proprietà di root: l'agente lo esegue ma non lo può modificare, né leggere il `.env` del progetto), scrive `~raspi-agent/.config/raspi-agent/mcp.json` e prova `get_service_health`. **Va rilanciato dopo ogni `git pull`** che tocca `mcp/` o `config/agent.json`.

## Provare senza consumare token

```bash
# Elenco degli strumenti
sudo -u raspi-agent -H node --env-file=/home/raspi-agent/.config/raspi-agent/agent.env /opt/raspi-agent/tools/mcp-call.js
# Chiamata di uno strumento
sudo -u raspi-agent -H node --env-file=/home/raspi-agent/.config/raspi-agent/agent.env /opt/raspi-agent/tools/mcp-call.js get_summary '{"from":"-6h","source":"lab","metrics":["pm2_5"]}'
```

Sul PC, con il simulatore: `npm run simulator -- --broker`, poi `node battery-cmd-bridge.js`, `npm run supervisor` e `npm run mcp-call -- get_live_status`.

## Strumenti

| Strumento | Cosa restituisce / fa |
|---|---|
| `get_live_status` | Valori attuali (lab, batteria), profilo attivo con `limits` e `commandBounds`, interblocco, eventi aperti. Legge `supervisor/status` |
| `get_service_health` | Servizi systemd, MariaDB, MQTT, supervisore |
| `get_summary` | Riassunti `minute`/`hour`/`day` (auto) da `summary_minute`/`summary_hour`, in forma compatta a colonne |
| `get_events` | Eventi del supervisore (default: ultime 24 h, da warning in su, più quelli aperti) |
| `get_report_data` | Numeri già calcolati per un report su ore intere (default ultime 24 h, max 31 giorni): per grandezza avg/min/max/p95, copertura, confronto con il periodo precedente, ora di picco e di minimo, confronto con i valori guida OMS (`reports.references`); batteria: tempo in ogni stato, tensioni, carica stimata, valori del registro 405; eventi raggruppati per condizione ed esiti del triage |
| `get_battery_cycles` | Fasi di carica e scarica da `battery_phases` (default ultimi 30 giorni, max 100 fasi) in forma compatta a colonne: durata, mAh, Wh, segno della corrente, tensioni, CC/CV, resistenza interna; cicli carica → scarica (pausa massima `cycles.maxRestHours`) con efficienza coulombica ed energetica; segno osservato della corrente per modo; fase in corso |
| `query_readonly` | SQL di sola lettura: una istruzione, niente commenti, max 200 righe e 10 s |
| `read_notes` / `write_notes` | Memoria dell'agente: file Markdown in `~raspi-agent/notes` (max 16 KB ciascuno) |
| `send_telegram` | Messaggio all'utente, inviato dal supervisore con il prefisso 🤖 (max 30/ora) |
| `request_escalation` | Solo nel triage: chiede al supervisore un'indagine con Sonnet sugli eventi indicati (`supervisor/agent/escalate`) |
| `start_procedure` | Consegna al supervisore una procedura (passi `charge`/`discharge`/`rest`, `repeat`, `reason`) e restituisce `started` con id e durata massima, oppure `rejected` con il motivo. Richiesta su `supervisor/agent/procedure`, risposta su `procedure_reply` (attesa massima `procedures.replyTimeoutSeconds`). Vedi [supervisore.md](supervisore.md#procedure-batteria) |
| `stop_procedure` | Ferma la procedura in corso (il supervisore ferma la batteria) |
| `get_procedures` | Ultime procedure da `battery_procedures` (default 5, max 20): richiesta, esito, risultato di ogni passo |
| `send_battery_command` | `set_current_ma`, `set_voltage_mv`, `set_run_state`: validato, poi inviato su `command/request` (bridge → dispatch → ack) |

## Sicurezza dei comandi batteria

Il server rifiuta un comando prima dell'invio se:

- non è uno dei tre ammessi (`write_register` non esiste per l'agente);
- lo stato del supervisore manca o è vecchio (> 20 s), l'interblocco è scattato, il profilo non è utilizzabile, i dati della batteria sono vecchi (> 10 s);
- il valore esce dai **`commandBounds`**, cioè i limiti del profilo ristretti dei margini di [`config/agent.json`](../config/agent.json): tensione tra `vMin + 30` e `vMax − 30` mV, corrente al 95 % del massimo del modo;
- l'avvio (1 carica, 2 scarica) porterebbe a uno stato non valido: setpoint fuori limite per quel modo, tensione misurata già al limite, NTC assente o sopra `tempMax − 5 °C`, batteria non ferma (per cambiare modo bisogna fermarla prima).

Lo **stop** (`set_run_state 0`) è sempre consentito. Al massimo 6 comandi al minuto (lo stop è escluso). Ogni comando, eseguito, rifiutato o senza conferma, viene inviato al supervisore su `supervisor/agent/audit`: diventa un evento `agent:command` e un messaggio Telegram. L'interblocco del supervisore resta comunque attivo sui valori misurati.

Per il profilo `liion-18650-2600` i limiti dei comandi sono: 3030–4200 mV, carica ≤ 1235 mA, scarica ≤ 2470 mA, avvio sotto 40 °C.

## Topic MQTT

| Topic | Da → a | Contenuto |
|---|---|---|
| `supervisor/status` | supervisore → MCP | Stato completo (retained) |
| `sensors/battery/command/request` | MCP → bridge | Comando con `source: "agent"` e `reason` |
| `sensors/battery/command/ack` | servizio batteria → MCP | Esito del comando |
| `supervisor/agent/telegram` | MCP → supervisore | `{ text, level }` |
| `supervisor/agent/audit` | MCP → supervisore | `{ command, value, reason, outcome, message }` |
