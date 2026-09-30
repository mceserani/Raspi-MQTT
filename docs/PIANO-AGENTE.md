# Piano: monitoraggio e analisi delle misure affidati a un agente

> Documento di lavoro per riprendere il progetto in sessioni successive.
> Stato: **implementazione in corso sul ramo `feat/agente`** — vedi §9 per l'avanzamento.
> Ultimo aggiornamento: 2026-09-30

---

## ▶ Punto di ripartenza (aggiornato 2026-09-30)

**Fatto e pubblicato** sul ramo `feat/agente`: fase 0 (fondamenta), fase 1 (supervisore), primo profilo batteria reale (`liion-18650-2600`) e fase 2 (server MCP). Sul PC: 67 test verdi e prova completa con simulatore, bridge, supervisore e server MCP (comandi eseguiti, rifiutati, audit e messaggi arrivati al supervisore).

**Sul Pi (30/09):** passi 1–6 della fase 1 completati (prerequisiti, token Claude, bot Telegram con chat_id, supervisore installato, verifiche MariaDB). Il supervisore gira in osservazione **fino a venerdì mattina (2026-10-02)**: annotare eventi falsi o mancanti, segno della corrente in scarica, comportamento del registro 405.

**Fase 2 verificata sul Pi (30/09):** `setup-agent-mcp.sh` installato, Claude (`claude -p` come `raspi-agent`) usa gli strumenti MCP, `get_summary`/`get_events`/`query_readonly` funzionano su MariaDB reale, `send_telegram` e un comando batteria con audit arrivano su Telegram.

**Fase 3a fatta e pubblicata (30/09), da provare sul Pi:** lanciatore `raspi-agent-launcher` e comando `/ask`. Budget deciso: **10 esecuzioni al giorno, di cui al massimo 5 con Sonnet**. Documentazione: [lanciatore.md](lanciatore.md).

### Da fare sul Pi per la fase 3a

```bash
cd ~/Raspi-MQTT && git pull && npm install
sudo systemctl restart raspi-supervisor
./setup-agent-launcher.sh
```
Poi da Telegram: `/status` (riga `Agente: in attesa · oggi 0/10…`) e una domanda con `/ask`. Log: `journalctl -u raspi-agent-launcher -f`.

### Prossimo passo di sviluppo

**Fase 3b — istruzioni e triage**: `CLAUDE.md` nella cartella di lavoro dell'agente (procedure, formato delle risposte, uso dei profili e delle note), triage degli eventi `pending` (il supervisore invia un lavoro Haiku per gli eventi warning/critical, con escalation a Sonnet) e aggiornamento di `agent_status` (serve uno strumento MCP per segnare gli eventi gestiti: l'utente `agent_ro` non può scrivere, lo farà il supervisore su richiesta MQTT). Poi 3c: report giornaliero e settimanale, `/report`. Domanda aperta prima della 3c: orari dei report (§8, domanda 4).

---

## 1. Obiettivo

Affidare a un agente (Claude) la gestione delle misure del laboratorio:

- monitoraggio continuo dei sensori ambientali e della batteria;
- analisi periodica dei dati (qualità dell'aria **e** caratterizzazione batterie);
- capacità di **agire** sulla batteria (comandi), entro limiti di sicurezza;
- notifiche e interazione via **Telegram**.

Vincolo di progetto: **automatizzare via software il più possibile per risparmiare token**, lasciando all'agente solo interpretazione, decisione e pianificazione.

---

## 2. Stato attuale del sistema (dal repo)

### Sul Raspberry Pi (servizi systemd, creati da `setup-systemd-services.sh`)

| Servizio | File | Funzione |
|---|---|---|
| `raspi-labsens.service` | `labsens-mqtt.js` | Modbus addr 29, registri 64–69 (temperature, humidity, pm10, pm2_5, voc, nox, valori /100) + reg 34 (NTC, /10). Polling 1 s. Pubblica `sensors/lab/<sensore>` e `sensors/lab/ntc/temperature` (**senza retain**). Salva in `sensor_data.labsens_measurements`. |
| `raspi-battery.service` | `battery-mqtt.js` | Modbus addr 4. Registri 400–405: current/voltage setpoint, current/voltage measured (signed 16), run state (0 stopped, 1 charge, 2 discharge), battery type. Polling 1 s. Pubblica `sensors/battery/state` + topic singoli + `meta` (**retain**). Salva in `sensor_data.battery_measurements`. Esegue comandi da `sensors/battery/command/dispatch` e risponde su `command/ack`. |
| `raspi-battery-cmd-bridge.service` | `battery-cmd-bridge.js` | Valida i comandi su `command/request` (solo "è intero", **nessun limite di range**) e li inoltra su `command/dispatch`. |

Rilevamento automatico porte seriali: `modbus-autodetect.js`.

### Sul PC (dashboard TUI)

- `dashboard.js` — sola lettura, sottoscrive `sensors/lab/#`, render ANSI ogni secondo.
- `battery-remote-dashboard.js` — interattiva (readline); invia su `command/request` JSON del tipo:
  ```json
  { "commandId": "...", "command": "set_current_ma" | "set_voltage_mv" | "set_run_state" | "write_register",
    "value": 123, "register": 400, "source": "...", "timestamp": "ISO" }
  ```

**Conclusione chiave:** le dashboard sono client MQTT sottili. Per l'agente "usare le dashboard" = **parlare lo stesso protocollo MQTT/JSON**, non leggere lo schermo ANSI (costoso e inutile).

### Osservazioni emerse dalla lettura del codice

- ~86.400 righe/giorno per tabella (1 Hz) → l'agente **non** deve mai leggere dati grezzi.
- Log journald molto verbosi (`[DEBUG]` a ogni ciclo) → l'agente non deve leggere i log grezzi.
- `labsens` divide per 100 senza gestire il segno → temperature negative errate.
- Topic lab senza retain; soglia "stale" della dashboard a 15 s con polling a 1 s.
- Nessuna politica di retention sul DB (crescita illimitata).
- `write_register` libero nel bridge: pericoloso se esposto a un agente.

---

## 3. Decisioni prese

| Tema | Decisione |
|---|---|
| Tipo di analisi | **Entrambe**: qualità aria laboratorio + caratterizzazione batterie |
| Autonomia sulla batteria | **L'agente può agire**. I limiti saranno definiti più avanti per ogni tipo di batteria; per ora il sistema deve solo **prevedere che i limiti esistano** (struttura profili). |
| Dove gira l'agente | **Sul Raspberry Pi** |
| Notifiche | **Telegram** |
| Codice esistente | Non va modificato: tutto il nuovo software è **additivo** (nuovi file/servizi) |
| Hardware | Raspberry Pi 4B, 4 GB RAM (serve OS a 64 bit per Claude Code) |
| Pagamento agente | **Abbonamento Claude**: token di lunga durata (`claude setup-token`) in `CLAUDE_CODE_OAUTH_TOKEN`. La quota è condivisa con l'uso personale → budget espresso in **numero di esecuzioni/giorno**: 10 al giorno, di cui al massimo 5 con Sonnet |
| Modelli | **Haiku** per il triage degli eventi (con escalation); **Sonnet** per report, `/report`, `/ask`, decisioni e procedure batteria. Configurabili da file |
| Selezione profilo batteria | Supportate entrambe: registro 405 (`batteryTypeCodes`) e dichiarazione manuale, che ha la precedenza |
| Credenziali Telegram | Solo il supervisore conosce il token del bot; l'agente invia messaggi passando dal supervisore |

---

## 4. Architettura

```
┌──────────────────────── Raspberry Pi ────────────────────────────┐
│  Servizi esistenti (invariati)                                    │
│  labsens-mqtt · battery-mqtt · battery-cmd-bridge · MariaDB · MQTT│
│                          │                                        │
│                          ▼                                        │
│  NUOVO raspi-supervisor.service  (Node, deterministico, 0 token)  │
│   ├─ regole/soglie su MQTT           → tabella events             │
│   ├─ interblocco di sicurezza batteria (stop immediato)           │
│   ├─ aggregazioni SQL (minuto/ora, cicli batteria)                │
│   ├─ esecutore procedure batteria (macchina a stati)              │
│   ├─ bot Telegram (in/out)                                        │
│   └─ lanciatore agente (coda, budget giornaliero)                 │
│                          │ quando serve                           │
│                          ▼                                        │
│  Agente: Claude Code headless (claude -p) + server MCP            │
│   utente Linux dedicato, niente sudo, solo tool MCP               │
└───────────────────────────────────────────────────────────────────┘
                           │
                        Telegram
```

**Principio:** tutto ciò che è continuo, ripetitivo o critico per la sicurezza è software deterministico. L'agente interpreta, decide e pianifica.

### Livelli

- **Livello 0** — servizi esistenti (MQTT + MariaDB). Invariati.
- **Livello 1** — supervisore deterministico (0 token).
- **Livello 2** — agente Claude, invocato solo su eventi, a orari programmati o su richiesta Telegram.

---

## 5. Componenti

### 5.1 Supervisore (`raspi-supervisor.service`, Node)

**Regole continue** (sottoscrizione MQTT):
- soglie sui sensori (PM2.5, PM10, VOC, NOx, temperatura, umidità);
- dati fermi (nessun messaggio da N secondi);
- variazioni troppo rapide (rate-of-change);
- batteria: misurato ≠ setpoint oltre tolleranza, tensione fuori finestra, cambio di `run_state` non comandato;
- salute servizi: `systemctl is-active`, conteggio errori recenti nel journal (solo conteggi, non testo).

**Output:** tabella `supervisor_events` (timestamp, sorgente, tipo, gravità info/warning/critical, dettagli JSON, stato gestione).

**Aggregazioni periodiche** (job SQL):
- riassunti per minuto e per ora: media, min, max, p95, numero campioni, buchi;
- tabella `battery_cycles` (vedi 5.4);
- statistiche giornaliere dell'aria (profili orari, superamenti).

**Lanciatore agente:**
- una sola esecuzione alla volta (coda);
- **budget giornaliero** di esecuzioni;
- sveglia l'agente solo per eventi sopra soglia, a orari programmati o su comando Telegram.

### 5.2 Sicurezza batteria (i limiti non dipendono dall'LLM)

- **Profili batteria** in un file di configurazione (es. `battery-profiles.json`), indicizzati per `batteryType` (registro 405) o per tipo dichiarato a mano. Campi previsti:
  - `vMin`, `vMax` (mV)
  - `iChargeMax`, `iDischargeMax` (mA)
  - `tempMax` (°C, da NTC)
  - `maxPhaseDuration` (s)
  - *(valori da definire in seguito — per ora solo struttura/segnaposto)*
- **Punto 1, tool MCP:** rifiuta i comandi fuori dai limiti del profilo attivo prima dell'invio.
- **Punto 2, interblocco nel supervisore:** controlla i valori *misurati* (non i comandi). Se escono dalla finestra → `set_run_state 0` immediato + allarme Telegram critical. Funziona anche con agente bloccato o internet assente.
- **Default deny:** tipo di batteria sconosciuto o senza profilo → l'agente può solo osservare.
- **Niente `write_register`** per l'agente.
- **Audit:** ogni comando registrato con `source: "agent"` e notificato su Telegram.
- Percorso dei comandi: lo stesso della dashboard remota (`command/request` → bridge → `dispatch` → `ack`).

### 5.3 Esecutore di procedure batteria

L'agente **non** pilota la batteria passo passo: scrive una **procedura** e la consegna al supervisore (tool `start_procedure`), che la esegue come macchina a stati validata contro il profilo.

Esempio di procedura:
> carica CC a I fino a V_max → carica CV finché I < soglia → riposo 30 min → scarica CC fino a V_min → ripeti ×3

Il supervisore sveglia l'agente solo alla fine o in caso di anomalia.

### 5.4 Analisi (calcolate in codice, interpretate dall'agente)

**Batteria** — riconoscimento dei cicli dai cambi di `run_state`; per ciclo:
- capacità in Ah (integrazione della corrente nel tempo, coulomb counting);
- energia in Wh;
- efficienza coulombica ed energetica;
- durata delle fasi CC/CV;
- resistenza interna stimata da ΔV/ΔI ai gradini di setpoint;
- → tabella `battery_cycles`; l'agente valuta trend, degrado e anomalie tra cicli.

**Laboratorio:**
- profili giornalieri/orari;
- superamenti dei riferimenti (es. linee guida OMS per PM2.5/PM10);
- correlazioni tra grandezze;
- deriva NTC vs temperatura del sensore;
- buchi nei dati / qualità del dato.

### 5.5 Server MCP (la "dashboard per agenti")

| Tool | Funzione |
|---|---|
| `get_live_status` | Snapshot compatto JSON di lab + batteria + profilo attivo |
| `get_summary(range, granularity)` | Riassunti aggregati |
| `get_events(since, severity)` | Eventi del supervisore |
| `get_battery_cycles(since)` | Cicli con metriche calcolate |
| `query_readonly(sql)` | Analisi ad hoc; utente MariaDB **read-only**, limite righe |
| `get_service_health` | Stato servizi + contatori errori |
| `send_battery_command(cmd, value)` | Solo `set_current_ma`, `set_voltage_mv`, `set_run_state`; validato contro il profilo |
| `start_procedure(spec)` / `stop_procedure()` | Procedure batteria |
| `send_telegram(text, level)` | Messaggi all'utente |
| `read_notes()` / `write_notes()` | Memoria dell'agente (conclusioni precedenti → report a delta) |

### 5.6 Telegram

- **Dal supervisore (0 token):** allarmi info/warning/critical con deduplica e limite di frequenza; cicli completati; procedure concluse.
- **Dall'agente:** report giornaliero sintetico, report settimanale approfondito, esito e motivazione delle azioni.
- **Comandi in entrata** (solo dal chat_id autorizzato):

| Comando | Gestito da | Token |
|---|---|---|
| `/status` | supervisore | 0 |
| `/stop` | supervisore (stop immediato batteria) | 0 |
| `/eventi` | supervisore (eventi aperti) | 0 |
| `/battery [profilo\|auto]` | supervisore (mostra o dichiara il profilo batteria) | 0 |
| `/reset` | supervisore (riarma l'interblocco) | 0 |
| `/help` (anche `/start`) | supervisore (elenco dei comandi) | 0 |
| `/report` | agente (report on demand) | sì |
| `/ask <domanda>` | agente (domanda libera sui dati) | sì |

### 5.7 Runtime dell'agente

- Claude Code headless (`claude -p`) lanciato dal supervisore:
  - cartella di lavoro con istruzioni (`CLAUDE.md`: procedure, formato report, uso dei profili);
  - `--mcp-config` → server MCP;
  - tool limitati al solo MCP; tetto sul numero di turni;
  - utente Linux dedicato, senza sudo.
- Modelli: **Haiku** per il triage degli eventi; modello più capace per report settimanali e indagini.
- Memoria: note persistenti delle conclusioni precedenti → report a delta.
- Evoluzione possibile: Agent SDK (TypeScript) riusando lo stesso server MCP, se serve più controllo su sessioni e costi.

---

## 6. Strategie di risparmio token

1. **Escalation a livelli:** il supervisore filtra tutto; eventi di routine → Haiku (annota / indaga / avvisa); modello grande solo per indagini e report settimanali.
2. **Mai dati o log grezzi:** solo riassunti JSON strutturati.
3. **Report a delta:** l'agente parte dalle proprie note precedenti.
4. **Calcoli in codice:** capacità, trend, correlazioni in SQL/Node; l'agente riceve numeri già pronti.
5. **Procedure batteria eseguite dal supervisore**, non passo passo dall'agente.
6. **Budget giornaliero** di esecuzioni nel lanciatore.

---

## 7. Piano a fasi

1. **Prerequisiti**
   - utente MariaDB read-only per l'agente;
   - utente Linux dedicato all'agente;
   - installazione Claude Code sul Pi + autenticazione;
   - creazione bot Telegram (BotFather) + chat_id autorizzato.
2. **Supervisore v1**: regole + tabella `events`, interblocco con profili segnaposto, aggregazioni, Telegram in uscita.
3. **Server MCP**: tool di lettura + `send_battery_command` e `start_procedure` con validazione profili.
4. **Agente**: istruzioni, triage eventi, report giornaliero/settimanale, `/report` e `/ask`.
5. **Procedure batteria + tabella `battery_cycles`**; compilazione dei profili reali.
6. *(Opzionale, da valutare)* retention DB, eventuale snapshot JSON non interattivo per le dashboard.

---

## 8. Domande aperte (da risolvere prima di scrivere codice)

1. ~~Modello e RAM del Raspberry Pi~~ → Pi 4B, 4 GB.
2. ~~Pagamento dell'agente~~ → abbonamento Claude.
3. **Tipi di batteria:** il registro `batteryType` (405) li distingue in modo affidabile? *(Non blocca: il codice supporta registro e dichiarazione manuale.)*
4. **Orari dei report:** ora del report giornaliero e giorno del report settimanale.
5. **Valori dei profili batteria** (da definire più avanti per ogni tipo).

---

## 9. Tabella di marcia e avanzamento

Ramo di lavoro: `feat/agente`. Test: `npm test` (`node:test`). Prova senza hardware: `npm run simulator -- --broker`.

| # | Tappa | Stato |
|---|---|---|
| 0 | Fondamenta: `.env.example`, `config/battery-profiles.json` + `lib/battery-profiles.js`, simulatore (`tools/simulator.js`, `tools/dev-broker.js`), `setup-agent-prereqs.sh` | ✅ fatto (script prerequisiti da eseguire sul Pi) |
| 1a | Supervisore: schema DB (`supervisor_events`, `summary_minute`, `summary_hour`, `supervisor_state`) | ✅ fatto (da verificare su MariaDB reale) |
| 1b | Supervisore: regole (soglie, dati fermi, rate-of-change, batteria, salute servizi) | ✅ fatto (soglie da tarare) |
| 1c | Supervisore: interblocco sui valori misurati + profilo attivo, default deny | ✅ fatto |
| 1d | Supervisore: aggregazioni minuto/ora | ✅ fatto |
| 1e | Supervisore: Telegram in uscita + `/status`, `/stop`, `/eventi`, `/battery`, `/reset` | ✅ fatto (da provare con il bot reale) |
| 1f | Supervisore: `raspi-supervisor.service` (`setup-supervisor-service.sh`) | ✅ fatto |
| 2a | MCP: tool di lettura (`get_live_status`, `get_service_health`, `get_summary`, `get_events`, `query_readonly`, note) | ✅ verificato sul Pi |
| 2b | MCP: `send_battery_command` validato, `send_telegram`, audit (`setup-agent-mcp.sh`) | ✅ verificato sul Pi |
| 3a | Agente: lanciatore (coda, budget esecuzioni/giorno, `claude -p`) + `/ask` | ✅ fatto (da provare sul Pi) |
| 3b | Agente: `CLAUDE.md`, triage Haiku → Sonnet | ⏳ |
| 3c | Agente: report giornaliero/settimanale, `/report` | ⏳ |
| 4a | `battery_cycles` + `get_battery_cycles` | ⏳ |
| 4b | Procedure batteria (macchina a stati) | ⏳ |
| 4c | Profili reali | 🟡 primo profilo `liion-18650-2600` (limiti prudenti, da verificare sul banco); altri tipi da definire |
| 5 | Opzionale: retention DB, snapshot JSON | da decidere |

### Note di implementazione

- **Bug del segno di `labsens`:** il codice esistente non si tocca; il supervisore reinterpreta i valori come interi con segno (valori ≥ 327,68 per le grandezze /100 → negativi). Il simulatore riproduce il bug di proposito.
- **Convenzione corrente (ipotesi da verificare sul banco):** corrente misurata positiva in carica, negativa in scarica.
- **Supervisore:** documentazione operativa in [supervisore.md](supervisore.md). Lo stop dell'interblocco e di `/stop` va direttamente su `command/dispatch` (non dipende dal bridge). Lo stato è pubblicato su `supervisor/status` (retained) per il server MCP.
- **Server MCP:** documentazione in [mcp.md](mcp.md). I comandi sono validati contro lo stato pubblicato dal supervisore (unica fonte del profilo attivo e del latch); i limiti dei comandi (`commandBounds`) sono quelli del profilo ristretti dei margini di `config/agent.json`, così un setpoint accettato non fa scattare l'interblocco. Il server è installato in `/opt/raspi-agent` come root: l'agente non può modificarlo.
- **Separazione utenti:** il supervisore gira come l'utente dei servizi esistenti; l'agente come `raspi-agent`. Il supervisore non può lanciare processi come un altro utente senza sudo, quindi il lanciatore (3a) sarà un servizio separato che gira come `raspi-agent` e riceve i lavori dal supervisore.
