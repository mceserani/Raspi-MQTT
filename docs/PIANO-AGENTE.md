# Piano: monitoraggio e analisi delle misure affidati a un agente

> Documento di lavoro per riprendere il progetto in sessioni successive.
> Stato: **implementazione in corso sul ramo `feat/agente`** — vedi §9 per l'avanzamento.
> Ultimo aggiornamento: 2026-10-03

---

## ▶ Punto di ripartenza (aggiornato 2026-10-03)

**Fatto e pubblicato** sul ramo `feat/agente`: fase 0 (fondamenta), fase 1 (supervisore), primo profilo batteria reale (`liion-18650-2600`), fase 2 (server MCP), fase 3a (lanciatore e `/ask`), fase 3b (`CLAUDE.md` e triage), fase 3c (report, verificata sul Pi), pulizia del database (attiva dal 03/10), fase 4a (fasi e cicli della batteria, verificata sul Pi) e fase 4b (procedure batteria, da verificare sul Pi). Sul PC: 125 test verdi (`npm test`), procedura completa provata con simulatore, bridge e supervisore (`npm test`) e prove con simulatore, bridge, supervisore, server MCP e lanciatore. Documentazione generale aggiornata (README, architettura, installazione, riferimento, utilizzo, diagnostica).

**Sul Pi (30/09):** passi 1–6 della fase 1 completati (prerequisiti, token Claude, bot Telegram con chat_id, supervisore installato, verifiche MariaDB). Il supervisore gira in osservazione **fino a venerdì mattina (2026-10-02)**: annotare eventi falsi o mancanti, segno della corrente in scarica, comportamento del registro 405.

**Fase 2 verificata sul Pi (30/09):** `setup-agent-mcp.sh` installato, Claude (`claude -p` come `raspi-agent`) usa gli strumenti MCP, `get_summary`/`get_events`/`query_readonly` funzionano su MariaDB reale, `send_telegram` e un comando batteria con audit arrivano su Telegram.

**Fase 3a verificata sul Pi (30/09):** lanciatore `raspi-agent-launcher` e `/ask` funzionano. Budget: **10 esecuzioni al giorno, di cui al massimo 5 con Sonnet**; dal 03/10 **20, di cui 10 con Sonnet**. Documentazione: [lanciatore.md](lanciatore.md).

**Fase 3b verificata sul Pi (30/09):** `CLAUDE.md` dell'agente, triage automatico degli eventi (Haiku, a gruppi, al massimo uno ogni 60 min, 10 min con un critical), indagini con Sonnet su richiesta del triage (max 2 al giorno), riserva di budget per `/ask` (il triage lascia sempre 3 esecuzioni libere), `agent_status` aggiornato dal supervisore. Il triage funziona e il contatore delle esecuzioni sale. Il lanciatore legge `config/agent.json` solo all'avvio: dal 01/10 `./setup-agent-mcp.sh` lo riavvia da solo, dopo aver aspettato l'eventuale lavoro in corso.

Nei prossimi giorni: annotare i triage inutili o sbagliati (servono a migliorare `CLAUDE.md` e le soglie) e, da venerdì 2026-10-02, riportare le osservazioni del supervisore (eventi falsi o mancanti, segno della corrente in scarica, registro 405).

**Fase 3c verificata sul Pi (02/10):** `/report`, report giornalieri e primo report settimanale arrivati e corretti. Corretto un primo problema: l'agente provava a inviare il report con `send_telegram` e, negato lo strumento, chiedeva conferma all'utente; ora le istruzioni vietano le richieste di conferma. Report giornaliero alle **18:00 con Haiku**, settimanale il **venerdì alle 15:00 con Sonnet**, `/report [giorno|settimana]` con Sonnet. Nuovo strumento MCP `get_report_data` (numeri già calcolati: statistiche, copertura, confronto con il periodo precedente, ore di picco, valori guida OMS, attività batteria, eventi raggruppati); report a delta con le note `report-giornaliero` e `report-settimanale`. Il venerdì arrivano entrambi i report. Query SQL di `get_report_data` verificate sul Pi il 03/10 con `mcp-call`, anche su 7 giorni.

**Pulizia del database:** la prova a vuoto della notte del 02/10 avrebbe cancellato 15.590 righe del laboratorio e 12.618 della batteria ferma, anteriori al primo riassunto: dati di prima del supervisore. Corretto il 02/10: la pulizia non tocca le righe anteriori al primo riassunto orario (sul Pi: 2026-09-29 08:00). Prova a vuoto del 03/10 alle 03:00 verificata sul Pi: tutti i conteggi a 0, come atteso. Dal 03/10 `dryRun: false`: la prima cancellazione vera sarà la notte del **14/10** (grezzi dal 29/09 08:00 al 30/09 03:00); il giorno dopo controllare `retention.last` (`dryRun: false`, conteggi plausibili). Il log si legge con `journalctl --namespace=raspi-agent -u raspi-supervisor | grep RETENTION` (journal separato e persistente dal 02/10: quello normale è in RAM e i `[DEBUG]` dei servizi esistenti lo riempiono in meno di un'ora).

**Fase 4a verificata sul Pi (02/10):** il supervisore riconosce cariche e scariche dai cambi di `run_state` e le salva in `battery_phases` (durata, mAh, Wh, segno della corrente, tensioni, CC/CV, resistenza interna stimata), con evento e messaggio 🔋 a fine fase. Strumento MCP `get_battery_cycles`: fasi, cicli carica → scarica con efficienza, segno osservato della corrente, fase in corso. Il calcolo non dipende dalla convenzione del segno. La tabella si chiama `battery_phases`; i cicli si formano nello strumento.

**Fase 4b (02/10): procedure batteria.** L'agente consegna con `start_procedure` una sequenza di passi (`charge`/`discharge` con setpoint, `maxMinutes` obbligatorio e condizioni `until`; `rest`; `repeat`) e il supervisore la valida contro il profilo attivo e la esegue da solo, con i comandi che passano dal bridge. Ogni anomalia (interblocco, cambio di stato esterno, dati fermi, profilo cambiato, comando senza conferma) ferma la batteria e chiude la procedura; `/stop` e `stop_procedure` la fermano; un riavvio del supervisore la chiude e ferma la batteria. Durante una procedura i comandi diretti dell'agente sono rifiutati. Telegram: ▶️ all'avvio, ✅/⏹️/⚠️ alla fine, `/procedura` per lo stato. A fine procedura un lavoro `procedure` (Sonnet) analizza risultati e fasi. Registro in `battery_procedures`, lettura con `get_procedures`. Solo `/ask` (richiesta esplicita dell'utente) può avviare una procedura; l'indagine può solo fermarla. Dettagli in [supervisore.md](supervisore.md#procedure-batteria).

**Prima prova della 4b sul Pi (03/10, P20261003-100901):** carica e riposo regolari; la scarica non è partita perché il setpoint di tensione era 4200 mV con la batteria a circa 3370 mV. Il banco porta sempre la batteria verso il setpoint (non carica sopra, non scarica sotto): comportamento atteso, si mantiene. Corretto (03/10): prima di ogni passo il supervisore verifica tensione e setpoint e, se il passo non partirebbe, chiude la procedura spiegando il motivo senza inviare il comando; una soglia `voltageBelowMv` sotto il setpoint di scarica viene rifiutata; istruzioni dell'agente e descrizione di `start_procedure` spiegano che in scarica `voltageMv` è la tensione finale; il simulatore fa lo stesso. Corretto anche il ⚠️ doppio su Telegram: gli eventi delle procedure non passano più dal notificatore, che li inviava una seconda volta. Seconda prova (03/10, P20261003-103241, setpoint di scarica 3200 mV corretto): la scarica di nuovo non è "partita". Causa vera: il banco accetta `set_run_state 2` e scarica, ma il registro 404 in lettura vale **1 anche in scarica** (confermato su `battery_measurements`: `run_state = 2` non compare mai, le scariche sono `run_state = 1` con corrente negativa). La procedura aspettava 2 e fermava la batteria. Conseguenze più ampie, tutte corrette il 03/10 con lo stato effettivo (`lib/run-state.js`: registro diverso da 0 + segno della corrente, con il modo noto o comandato quando la corrente è vicina a zero): interblocco (`vMin` e `iDischargeMax` non si applicavano mai in scarica), regole (falso "tensione in carica sopra il setpoint" a ogni scarica), procedure, fasi (scariche registrate come cariche), report (tempo di scarica contato come carica). Il simulatore riproduce il registro. Sul Pi, dopo l'aggiornamento: ricalcolare le fasi (`DELETE FROM battery_phases; DELETE FROM supervisor_state WHERE state_key = 'cycles';` prima del riavvio). Da ripetere: passi 5 e 6 qui sotto.

Passi sul Pi per la 4b:
1. `cd ~/Raspi-MQTT && git pull`
2. `sudo systemctl restart raspi-supervisor` (crea `battery_procedures`)
3. `./setup-agent-mcp.sh` (nuovi strumenti, istruzioni dell'agente; riavvia il lanciatore)
4. `/procedura` da Telegram → "Nessuna procedura in corso".
5. Prova breve con il profilo `liion-18650-2600` attivo e la batteria ferma, per esempio: `/ask avvia una procedura di prova: carica a 500 mA e 4200 mV per al massimo 5 minuti, riposo 2 minuti, scarica a 500 mA e 3500 mV per al massimo 5 minuti`. Attesi: ▶️ con i passi, 🔋 per carica e scarica, ✅ alla fine e poi l'analisi 🤖.
6. Prova di interruzione: avviarne un'altra e mandare `/stop` durante la carica → ⏹️ e batteria ferma.

### Prossimo passo di sviluppo

Dopo la verifica della 4b: **fase 4c**, profili reali (valori dai datasheet delle batterie usate; serve l'utente) e prima procedura di caratterizzazione vera (prova di capacità). Segno della corrente verificato il 02/10 (positiva in carica, negativa in scarica). Da riportare: osservazioni del supervisore (eventi falsi o mancanti, registro 405).

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
- Nessuna politica di retention sul DB (crescita illimitata). → risolto dalla pulizia notturna del supervisore (fase 5a); misura sul Pi del 01/10: circa 22 MB al giorno, 100 GB liberi.
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
| Pagamento agente | **Abbonamento Claude**: token di lunga durata (`claude setup-token`) in `CLAUDE_CODE_OAUTH_TOKEN`. La quota è condivisa con l'uso personale → budget espresso in **numero di esecuzioni/giorno**: 20 al giorno, di cui al massimo 10 con Sonnet (10 e 5 fino al 03/10) |
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
- tabella `battery_phases` (cariche e scariche; vedi 5.4);
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
- → tabella `battery_phases` (una riga per fase; i cicli carica → scarica si formano in `get_battery_cycles`); l'agente valuta trend, degrado e anomalie tra cicli.

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
| `get_report_data(from, to)` | Numeri già calcolati per i report (statistiche, confronti, eventi raggruppati, attività batteria) |
| `get_battery_cycles(since)` | Fasi e cicli con metriche calcolate, segno osservato della corrente, fase in corso |
| `query_readonly(sql)` | Analisi ad hoc; utente MariaDB **read-only**, limite righe |
| `get_service_health` | Stato servizi + contatori errori |
| `send_battery_command(cmd, value)` | Solo `set_current_ma`, `set_voltage_mv`, `set_run_state`; validato contro il profilo |
| `start_procedure(spec)` / `stop_procedure()` / `get_procedures()` | Procedure batteria eseguite dal supervisore |
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
5. **Procedure batteria + tabella `battery_phases`**; compilazione dei profili reali.
6. *(Opzionale, da valutare)* retention DB, eventuale snapshot JSON non interattivo per le dashboard.

---

## 8. Domande aperte (da risolvere prima di scrivere codice)

1. ~~Modello e RAM del Raspberry Pi~~ → Pi 4B, 4 GB.
2. ~~Pagamento dell'agente~~ → abbonamento Claude.
3. **Tipi di batteria:** il registro `batteryType` (405) li distingue in modo affidabile? *(Non blocca: il codice supporta registro e dichiarazione manuale.)*
4. ~~Orari dei report~~ → giornaliero alle 18:00 (Haiku), settimanale il venerdì alle 15:00 (Sonnet).
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
| 3a | Agente: lanciatore (coda, budget esecuzioni/giorno, `claude -p`) + `/ask` | ✅ verificato sul Pi |
| 3b | Agente: `CLAUDE.md`, triage Haiku → Sonnet, `agent_status` | ✅ verificato sul Pi |
| 3c | Agente: report giornaliero/settimanale, `/report`, `get_report_data` | ✅ verificato sul Pi |
| 4a | `battery_phases` + `get_battery_cycles` | ✅ verificato sul Pi |
| 4b | Procedure batteria: `start_procedure`, `stop_procedure`, `get_procedures`, `/procedura`, tabella `battery_procedures` | ✅ fatto (provato con il simulatore, da verificare sul Pi) |
| 4c | Profili reali | 🟡 primo profilo `liion-18650-2600` (limiti prudenti, da verificare sul banco); altri tipi da definire |
| 5a | Pulizia del database (`retention`): grezzi del laboratorio e della batteria ferma 14 giorni, prove batteria sempre, riassunti al minuto 1 anno | ✅ prova a vuoto verificata sul Pi (03/10), attiva da `dryRun: false`; prima cancellazione il 14/10 |
| 5b | Opzionale: snapshot JSON per le dashboard | da decidere |

### Note di implementazione

- **Bug del segno di `labsens`:** il codice esistente non si tocca; il supervisore reinterpreta i valori come interi con segno (valori ≥ 327,68 per le grandezze /100 → negativi). Il simulatore riproduce il bug di proposito.
- **Convenzione corrente (verificata sul banco il 02/10):** corrente misurata positiva in carica, negativa in scarica. Dal 03/10 il codice nuovo ne dipende: il registro 404 vale 1 anche in scarica e la direzione si ricava dal segno (`lib/run-state.js`).
- **Supervisore:** documentazione operativa in [supervisore.md](supervisore.md). Lo stop dell'interblocco e di `/stop` va direttamente su `command/dispatch` (non dipende dal bridge). Lo stato è pubblicato su `supervisor/status` (retained) per il server MCP.
- **Server MCP:** documentazione in [mcp.md](mcp.md). I comandi sono validati contro lo stato pubblicato dal supervisore (unica fonte del profilo attivo e del latch); i limiti dei comandi (`commandBounds`) sono quelli del profilo ristretti dei margini di `config/agent.json`, così un setpoint accettato non fa scattare l'interblocco. Il server è installato in `/opt/raspi-agent` come root: l'agente non può modificarlo.
- **Separazione utenti:** il supervisore gira come l'utente dei servizi esistenti; l'agente come `raspi-agent`. Il supervisore non può lanciare processi come un altro utente senza sudo, quindi il lanciatore (3a) sarà un servizio separato che gira come `raspi-agent` e riceve i lavori dal supervisore.
