# Supervisore (`raspi-supervisor`)

Livello deterministico tra i servizi esistenti e l'agente (vedi [PIANO-AGENTE.md](PIANO-AGENTE.md), §5.1). Non usa token: sorveglia MQTT, apre e chiude eventi, ferma la batteria se esce dai limiti del profilo, calcola i riassunti e parla con Telegram.

I servizi esistenti non vengono modificati: il supervisore si limita a leggere i loro topic e a inviare lo stop sullo stesso canale dei comandi.

---

## Installazione sul Raspberry

```bash
git fetch origin && git checkout feat/agente
# in .env: TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID (vedi sotto)
./setup-supervisor-service.sh
journalctl -u raspi-supervisor -f
```

Lo script crea `raspi-supervisor.service` (stesso utente dei servizi esistenti, gruppo `systemd-journal` per leggere i contatori di errore), lo abilita e lo avvia.

### Telegram

1. Crea il bot con **@BotFather** (`/newbot`) e copia il token in `TELEGRAM_BOT_TOKEN`.
2. Lascia vuoto `TELEGRAM_CHAT_ID`, avvia il supervisore e scrivi un messaggio qualsiasi al bot: risponde con il tuo chat_id.
3. Copia il chat_id in `TELEGRAM_CHAT_ID` e riavvia: da quel momento il bot accetta comandi **solo** da quella chat.

Senza token il supervisore funziona lo stesso: le notifiche finiscono solo nel journal.

### Prova sul PC, senza hardware

```bash
npm run simulator -- --broker --speed 60   # broker + sensori + batteria simulati
npm run supervisor                          # in un altro terminale
```

Nel simulatore: `fault overvoltage`, `set pm2_5 120`, `pause lab 60`, `fault runstate`… (`help` per l'elenco). Per provare l'interblocco serve un profilo utilizzabile con `batteryTypeCodes: [0]` (il simulatore usa il tipo 0).

---

## Cosa controlla

| Regola | Chiave evento | Gravità |
|---|---|---|
| Soglia alta/bassa (media mobile `window`, dopo `sustain`, chiusura con `hysteresis`) | `lab:threshold:<sensore>:<high\|low>` | warning / critical |
| Lettura fuori dall'intervallo plausibile `valid` | `lab:invalid:<sensore>` | warning |
| Variazione rapida (escursione > `maxDelta` in `per` secondi) | `lab:rate:<sensore>` | warning |
| Nessun dato da `staleSeconds` | `lab:stale`, `battery:stale` | warning (critical se la batteria era in marcia) |
| Corrente lontana dal setpoint (in carica solo in fase CC) | `battery:current_deviation` | warning |
| Tensione in carica sopra il setpoint | `battery:voltage_over_setpoint` | warning |
| Batteria in marcia senza profilo utilizzabile | `battery:no_profile` | warning |
| Cambio di `run_state` senza un ack di comando | `battery:uncommanded_run_state` | warning |
| Comando rifiutato (ack `error`) | `battery:command_error` | warning |
| Servizio non attivo | `health:inactive:<unità>` | secondo `health.services` |
| Troppi `[ERROR]`/`[FATAL]` nel journal | `health:errors:<unità>` | warning |
| Supervisore scollegato da MQTT / MariaDB | `supervisor:mqtt_down`, `supervisor:db_down` | critical / warning |

Tutte le soglie sono in [`config/supervisor.json`](../config/supervisor.json): i valori attuali sono **iniziali, da tarare**.

Le temperature arrivano da `labsens-mqtt.js` senza segno (−1,5 °C diventa 653,86): il supervisore le corregge prima di valutarle e di aggregarle.

## Interblocco batteria

Controlla i valori **misurati** a ogni stato ricevuto (1 Hz), solo con batteria in marcia e profilo utilizzabile:

- tensione > `vMax`; tensione < `vMin` in scarica;
- |corrente| > `iChargeMax` in carica o > `iDischargeMax` in scarica (in valore assoluto: non dipende dalla convenzione di segno);
- temperatura NTC > `tempMax`, oppure NTC assente da `temperatureStaleSeconds` (se `stopOnMissingTemperature`);
- fase attiva da più di `maxPhaseDuration`.

Una violazione confermata per `confirmSamples` campioni consecutivi invia `set_run_state 0` **direttamente su `command/dispatch`** (funziona anche senza il bridge), verifica che lo stato torni a 0 e riprova fino a `stopRetries` volte; se non basta apre `interlock:stop_failed` (critical). L'interblocco resta **scattato** (latch, salvato nel DB) finché non si usa `/reset`: fino ad allora il server MCP rifiuta all'agente ogni comando batteria tranne lo stop.

Profilo attivo: dichiarazione manuale (`/battery <nome>`) oppure `batteryTypeCodes` sul registro 405. Tipo sconosciuto, profilo segnaposto o incompleto → **solo osservazione**, interblocco inattivo (e `battery:no_profile` se la batteria è in marcia). Dopo aver modificato `config/battery-profiles.json`: `sudo systemctl reload raspi-supervisor`.

## Comandi Telegram

| Comando | Effetto |
|---|---|
| `/status` | Valori attuali, batteria, profilo, interblocco, eventi aperti, servizi, stato e budget dell'agente |
| `/stop` | Stop immediato della batteria, con conferma |
| `/eventi` | Eventi aperti |
| `/battery [nome\|auto]` | Mostra o dichiara il profilo batteria |
| `/reset` | Riarma l'interblocco dopo le verifiche |
| `/ask <domanda>` | Domanda all'agente sui dati: la risposta arriva con il prefisso 🤖 (vedi [lanciatore.md](lanciatore.md)) |
| `/report [giorno\|settimana]` | Report dell'agente sulle ultime 24 ore (default) o sugli ultimi 7 giorni, con Sonnet |
| `/help` | Elenco dei comandi (anche `/start`, inviato da Telegram all'apertura della chat) |

Notifiche: eventi dalla gravità `notifyMinSeverity` in su, rientri, al massimo `maxMessagesPerMinute` messaggi al minuto (i critical passano sempre).

## Triage degli eventi

Ogni `checkSeconds` il supervisore cerca gli eventi warning/critical con `agent_status = 'pending'` delle ultime `lookbackHours` ore, vecchi almeno `settleSeconds` (così quelli brevissimi arrivano già rientrati), e li manda all'agente in **un solo lavoro** `triage` (Haiku, al massimo `maxEventsPerJob` eventi). Tra un triage e l'altro passano almeno `minGapMinutes` minuti, `criticalMinGapMinutes` se c'è un critical. Serve il lanciatore attivo.

L'agente valuta gli eventi, avvisa l'utente solo se aggiunge informazioni utili, annota i fatti ricorrenti e può chiedere un'indagine (`request_escalation`): il supervisore lancia allora un lavoro `investigate` (Sonnet, al massimo `maxEscalationsPerDay` al giorno) la cui conclusione arriva su Telegram.

`agent_status` di un evento: `skip` (info, non valutato) → `pending` → `queued` → `handled` (triage concluso) / `escalated` (indagine chiesta) / `error` (esecuzione fallita, non ripetuta). Se il budget non basta l'evento torna `pending` e viene ripreso al triage successivo. Gli allarmi del supervisore partono comunque subito: il triage aggiunge solo la lettura dell'agente.

## Report programmati

Sezione `reports` di `config/supervisor.json`. Il supervisore manda all'agente:

- il **report giornaliero** alle `daily.time` (18:00): lavoro `report_daily` (Haiku) sulle 24 ore precedenti;
- il **report settimanale** il `weekly.day` alle `weekly.time` (venerdì, 15:00): lavoro `report_weekly` (Sonnet) sui 7 giorni precedenti.

Il lavoro parte `delayMinutes` dopo l'orario (così l'ultima ora è già nei riassunti) e il report arriva su Telegram con il prefisso 🤖. Se a quell'ora il lanciatore non è attivo il supervisore riprova fino a `maxDelayHours` ore dopo, poi salta il report e lo scrive nel log. L'ultimo report inviato è in `supervisor_state` (`reports.daily.lastSlot`, `reports.weekly.lastSlot`): un riavvio non lo ripete. All'avvio il log riporta gli orari (`Report programmati: …`); un orario o un giorno scritto male blocca l'avvio con un messaggio chiaro.

L'agente parte dai numeri di `get_report_data` e dalle proprie note (`report-giornaliero`, `report-settimanale`), così ogni report descrive le novità rispetto ai precedenti. Il venerdì arrivano entrambi i report.

## Pulizia del database

Sezione `retention` di `config/supervisor.json`. Ogni notte alle `time` (03:00) il supervisore cancella:

| Dati | Dopo | Chiave |
|---|---|---|
| Grezzi del laboratorio (`labsens_measurements`) | 14 giorni | `labRawDays` |
| Grezzi della batteria ferma (`run_state = 0`) | 14 giorni | `batteryIdleDays` |
| Grezzi della batteria durante le prove | mai (`0`) | `batteryTestDays` |
| Riassunti al minuto | 365 giorni | `summaryMinuteDays` |

I riassunti orari e gli eventi non vengono mai cancellati. Le righe della batteria ferma entro `testMarginMinutes` (60) da una carica o una scarica restano: i riposi fanno parte della prova. Non si cancella nulla che le aggregazioni non abbiano già riassunto. Per i dati grezzi il minimo è 8 giorni, perché il report settimanale li legge. La cancellazione procede a blocchi di `batchRows` righe, con una pausa tra un blocco e l'altro, così i servizi continuano a scrivere.

Con `dryRun: true` (impostazione iniziale) il supervisore non cancella nulla: scrive nel log quante righe cancellerebbe (`[RETENTION] would delete: …`). Dopo aver controllato, mettere `dryRun: false` e riavviare il supervisore. L'esito dell'ultima esecuzione è in `supervisor_state` (`retention.last`). MariaDB non riduce i file: lo spazio liberato viene riusato per i dati nuovi.

## Tabelle

| Tabella | Contenuto |
|---|---|
| `supervisor_events` | Un evento per condizione: apertura, gravità attuale e di picco, messaggio, dettagli JSON, `resolved_at`, `agent_status` (`pending` per warning/critical, `skip` per info: lo userà l'agente) |
| `summary_minute`, `summary_hour` | Per ogni bucket, sorgente (`lab`/`battery`) e grandezza: `samples`, media, min, max, p95, `max_gap_s`. I bucket senza dati sono scritti con `samples = 0` |
| `supervisor_state` | Stato persistente: profilo dichiarato, latch dell'interblocco, avanzamento delle aggregazioni, ultimo report programmato inviato, ultima pulizia |

Le date sono in ora locale, come nelle tabelle esistenti. Se MariaDB non risponde il supervisore continua a funzionare: gli eventi restano in coda e le aggregazioni recuperano quando torna.

Verifiche utili:

```sql
SELECT created_at, severity, message, resolved_at FROM supervisor_events ORDER BY id DESC LIMIT 20;
SELECT * FROM summary_hour WHERE source = 'lab' AND metric = 'pm2_5' ORDER BY bucket_start DESC LIMIT 24;
SELECT * FROM supervisor_state;
```

## Stato pubblicato

Ogni `statusPublishSeconds` il supervisore pubblica su `supervisor/status` (retained) uno snapshot JSON: valori attuali, profilo attivo con i limiti, latch, eventi aperti, salute dei servizi. Se il processo cade, il broker pubblica `{"online": false}` (last will). Il server MCP legge da qui lo stato per l'agente e per validare i comandi batteria.

Con l'agente il supervisore usa anche i topic `supervisor/agent/*`: pubblica i lavori (`jobs`) e riceve dal lanciatore stato (`launcher`) ed esiti (`results`), dal server MCP messaggi Telegram (`telegram`), audit dei comandi batteria (`audit`) e richieste di indagine (`escalate`). Elenco completo in [riferimento.md](riferimento.md#supervisore-e-agente).
