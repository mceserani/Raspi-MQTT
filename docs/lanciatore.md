# Lanciatore dell'agente

`raspi-agent-launcher.service` esegue l'agente (Claude Code headless, `claude -p`) quando il supervisore glielo chiede (vedi [PIANO-AGENTE.md](PIANO-AGENTE.md), §5.1 e §5.7). Gira come utente `raspi-agent` con `agent.env`, dal codice in `/opt/raspi-agent` (proprietà di root).

## Installazione sul Pi

```bash
cd ~/Raspi-MQTT && git pull && npm install
sudo systemctl restart raspi-supervisor
./setup-agent-launcher.sh
```

Lo script aggiorna `/opt/raspi-agent` (lancia `setup-agent-mcp.sh`), controlla Claude Code e il token, installa e avvia il servizio. Poi da Telegram:

- `/status` → deve comparire la riga `Agente: in attesa · oggi 0/10 esecuzioni (Sonnet 0/5)`;
- `/ask com'è andato il PM2.5 nelle ultime 6 ore?` → il bot conferma l'invio e dopo qualche decina di secondi arriva la risposta con il prefisso 🤖.

Log: `journalctl -u raspi-agent-launcher -f`.

## Come funziona

1. Il supervisore pubblica un lavoro su `supervisor/agent/jobs` (`{ jobId, kind, prompt, requestedBy, replyTelegram }`). Oggi lo fa `/ask`; nelle fasi 3b–3c anche il triage degli eventi e i report.
2. Il lanciatore lo mette in coda (massimo `maxQueue` in attesa) ed esegue **un lavoro alla volta**.
3. Controlla il **budget giornaliero**. Se è esaurito, rifiuta il lavoro e lo dice all'utente. Se è esaurita solo la quota Sonnet, il lavoro passa a Haiku e la risposta lo segnala.
4. Lancia `claude -p` nella cartella `~/workspace` con:
   - il modello e il numero massimo di turni del tipo di lavoro;
   - solo il server MCP `raspi` (`--strict-mcp-config`) e solo gli strumenti MCP elencati per quel tipo di lavoro;
   - tutti gli strumenti interni di Claude Code negati (shell, file, web);
   - il prompt passato su stdin;
   - un tempo massimo di `timeoutSeconds`.
5. Pubblica l'esito su `supervisor/agent/results` e, se richiesto, la risposta su `supervisor/agent/telegram`, che il supervisore invia all'utente.
6. Tiene aggiornato su `supervisor/agent/launcher` (retained) il proprio stato: online, lavoro in corso, coda, budget. Il supervisore lo mostra in `/status`.

Un'esecuzione è contata **quando parte**, anche se poi fallisce: un errore ripetuto non può consumare più del budget.

## Configurazione

Sezione `launcher` di [`config/agent.json`](../config/agent.json):

| Chiave | Valore | Significato |
|---|---|---|
| `maxRunsPerDay` | 10 | Esecuzioni al giorno (si azzerano a mezzanotte, ora locale) |
| `maxSonnetRunsPerDay` | 5 | Di cui con Sonnet; oltre si usa Haiku |
| `maxQueue` | 5 | Lavori in attesa al massimo |
| `timeoutSeconds` | 300 | Durata massima di un'esecuzione |
| `maxPromptChars` / `maxReplyChars` | 2000 / 3000 | Lunghezza massima di domanda e risposta |
| `systemPrompt` | | Istruzioni aggiunte a ogni esecuzione (in 3b arriverà `CLAUDE.md`) |
| `jobs.<tipo>` | | `model`, `maxTurns`, `tools` (strumenti MCP ammessi) |

Tipi di lavoro attuali: `ask` (Sonnet, solo strumenti di lettura: da `/ask` l'agente **non** può comandare la batteria né scrivere note) e `test` (Haiku, solo `get_live_status`).

Dopo una modifica: `./setup-agent-mcp.sh` e `sudo systemctl restart raspi-agent-launcher`. Il conteggio del giorno è in `~raspi-agent/.local/state/raspi-agent/budget.json`.
