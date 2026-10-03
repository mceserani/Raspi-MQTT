# Lanciatore dell'agente

`raspi-agent-launcher.service` esegue l'agente (Claude Code headless, `claude -p`) quando il supervisore glielo chiede (vedi [PIANO-AGENTE.md](PIANO-AGENTE.md), §5.1 e §5.7). Gira come utente `raspi-agent` con `agent.env`, dal codice in `/opt/raspi-agent` (proprietà di root).

## Installazione sul Pi

```bash
cd ~/Raspi-MQTT && git pull && npm install
sudo systemctl restart raspi-supervisor
./setup-agent-launcher.sh
```

Lo script aggiorna `/opt/raspi-agent` (lancia `setup-agent-mcp.sh`), controlla Claude Code e il token, installa e avvia il servizio. Poi da Telegram:

- `/status` → deve comparire la riga `Agente: in attesa · oggi 0/20 esecuzioni (Sonnet 0/10)`;
- `/ask com'è andato il PM2.5 nelle ultime 6 ore?` → il bot conferma l'invio e dopo qualche decina di secondi arriva la risposta con il prefisso 🤖.

Log: `journalctl --namespace=raspi-agent -u raspi-agent-launcher -f` (journal separato, vedi [supervisore.md](supervisore.md#log)).

## Come funziona

1. Il supervisore pubblica un lavoro su `supervisor/agent/jobs` (`{ jobId, kind, prompt, requestedBy, replyTelegram, eventIds }`): per `/ask` e `/report`, per il triage degli eventi, per le indagini e per i report programmati (vedi [supervisore.md](supervisore.md#triage-degli-eventi) e [supervisore.md](supervisore.md#report-programmati)).
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
| `systemPrompt` | | Breve istruzione aggiunta a ogni esecuzione (il resto è in `CLAUDE.md`) |
| `jobs.<tipo>` | | `model`, `maxTurns`, `reserve`, `tools` (strumenti MCP ammessi) |

Tipi di lavoro:

| Tipo | Chi lo lancia | Modello | Riserva | Strumenti |
|---|---|---|---|---|
| `ask` | `/ask` da Telegram | Sonnet | 0 | lettura, `start_procedure` e `stop_procedure` (niente comandi diretti né note) |
| `triage` | supervisore, sugli eventi warning/critical | Haiku | 3 | lettura, note, `send_telegram`, `request_escalation` |
| `investigate` | supervisore, su `request_escalation` del triage | Sonnet | 2 | lettura, `query_readonly`, note, `send_telegram`, `stop_procedure` |
| `report_daily` | supervisore, ogni giorno alle 18:00 | Haiku | 1 | lettura (con `get_report_data`), note |
| `report_weekly` | supervisore, il venerdì alle 15:00 | Sonnet | 1 | lettura, `query_readonly`, note |
| `report` | `/report` da Telegram | Sonnet | 0 | lettura, `query_readonly`, solo lettura delle note |
| `procedure` | supervisore, a fine procedura batteria (`procedures.analyzeOnEnd`) | Sonnet | 1 | `get_procedures`, `get_battery_cycles`, lettura, note |
| `test` | manuale | Haiku | 0 | `get_live_status` |

La **riserva** è il numero di esecuzioni che un lavoro automatico deve lasciare libere: con 20 al giorno il triage si ferma a 17 usate, le indagini a 18 e i report programmati a 19, così resta sempre almeno un'esecuzione per `/ask` e `/report`. Nessun lavoro automatico può comandare la batteria: solo `/ask`, cioè una richiesta esplicita dell'utente, può avviare una procedura; l'indagine può solo fermarla. Per cambiare basta modificare gli strumenti del tipo di lavoro in `config/agent.json`.

Le istruzioni dell'agente sono in [`agent/workspace/CLAUDE.md`](../agent/workspace/CLAUDE.md), installato da `setup-agent-mcp.sh` in `~raspi-agent/workspace/CLAUDE.md` (proprietà di root: l'agente non può riscriverle). Claude Code lo carica a ogni esecuzione.

Dopo una modifica: `./setup-agent-mcp.sh`, che riavvia anche il lanciatore (legge `config/agent.json` solo all'avvio). Se l'agente sta lavorando, lo script aspetta che finisca, al massimo `timeoutSeconds`. Il conteggio del giorno è in `~raspi-agent/.local/state/raspi-agent/budget.json`.
