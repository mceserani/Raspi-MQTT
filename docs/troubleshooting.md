# Diagnostica e problemi noti

- [Verifiche rapide](#verifiche-rapide)
- [Problemi frequenti](#problemi-frequenti)
- [Strumenti di diagnosi](#strumenti-di-diagnosi)
- [Limitazioni note](#limitazioni-note)
- [Note di sicurezza](#note-di-sicurezza)

---

## Verifiche rapide

```bash
# 1. i servizi sono attivi?
systemctl status raspi-labsens raspi-battery raspi-battery-cmd-bridge --no-pager

# 2. gli adattatori sono visibili?
ls -l /dev/serial/by-id/

# 3. broker e database sono attivi?
systemctl status mosquitto mariadb --no-pager

# 4. arrivano dati su MQTT?
mosquitto_sub -h localhost -u <utente> -P <password> -t 'sensors/#' -v -C 10

# 5. cosa dicono i log?
journalctl -u raspi-labsens -n 50 --no-pager
journalctl -u raspi-battery -n 50 --no-pager
```

## Problemi frequenti

### Il servizio non parte: `[FATAL] MARIADB_PASSWORD is not set`

Manca la variabile nel file `.env` (o il file non è nella cartella del progetto). Aggiungerla e riavviare il servizio.

### `[AUTODETECT] …: device N not found on any serial port`

Il servizio ha provato tutte le porte per ~10 tentativi senza ricevere risposta dall'indirizzo cercato. Il processo termina e systemd lo riavvia ogni 5 s, ripetendo la ricerca.

Le righe `[AUTODETECT]` precedenti mostrano l'esito per ogni porta:

| Messaggio | Causa probabile | Azione |
|---|---|---|
| `… busy (Error: … Resource temporarily unavailable / Cannot lock port)` | La porta è aperta da un altro processo (normalmente l'altro servizio, ed è corretto) | Se **tutte** le porte sono `busy`, verificare che non ci sia un'istanza manuale (`npm start`) o un altro programma (`minicom`, `screen`) aperto: `sudo fuser -v /dev/ttyUSB*` |
| `… busy (Error: … Permission denied)` | L'utente non appartiene a `dialout` | `sudo usermod -aG dialout <utente>` e riavviare il servizio/la sessione |
| `… no answer (Timed out)` | Nessun dispositivo con quell'indirizzo su quella porta | Controllare alimentazione, cablaggio A/B della linea RS-485, indirizzo (`*_MODBUS_ADDRESS`) e baud rate (`*_BAUD_RATE`) |
| Nessuna riga per porta | `/dev/serial/by-id/` vuota o inesistente | Adattatori non collegati o non riconosciuti: `dmesg | tail`, `lsusb` |

### I valori sono fermi / la dashboard mostra `(stale)`

Il servizio `raspi-labsens` non pubblica. Nel log cercare:

- `[ERROR] Failed to read Modbus registers: Timed out` ripetuto → il dispositivo non risponde. Dopo `LABSENS_MAX_FAILURES` errori consecutivi compare `consecutive read failures, closing … to re-detect the device` e parte un nuovo autodetect.
- `[POLL] Previous cycle still running, skipping this tick` ripetuto → un ciclo è bloccato, tipicamente perché il broker MQTT non è raggiungibile e la pubblicazione è in attesa. Verificare il broker.
- Nessuna riga recente → il processo è fermo: `systemctl status raspi-labsens`.

### Il log mostra spesso `readHoldingRegisters failed …, trying readInputRegisters…`

Il dispositivo risponde con un'eccezione alla funzione 03 ma accetta la 04 (o viceversa è stato un errore transitorio). Se succede **a ogni ciclo** è innocuo ma raddoppia il traffico sul bus e il tempo di lettura; non è possibile al momento forzare direttamente la funzione 04 da configurazione.

### I comandi alla batteria non hanno effetto

Seguire il percorso del comando:

```bash
mosquitto_sub -h localhost -u <utente> -P <password> -t 'sensors/battery/command/#' -v
```

1. **Non compare nulla su `command/request`** → il client non pubblica: credenziali MQTT errate, broker sbagliato (ricordare che `battery-remote-dashboard.js` usa per default `mqtt://iot-edge-1:1883`), `BATTERY_MQTT_TOPIC` diverso.
2. **Compare `request` ma non `dispatch` né `ack`** → il bridge non è attivo, oppure il JSON è malformato (il bridge lo scarta senza ACK: vedere `journalctl -u raspi-battery-cmd-bridge`).
3. **ACK `error` con `handledBy: battery-cmd-bridge`** → payload non valido; il messaggio indica il campo errato (spesso `commandId` mancante).
4. **Compare `dispatch` ma nessun ACK** → `raspi-battery` non è attivo o non è sottoscritto (ad es. è bloccato nell'autodetect all'avvio).
5. **ACK `error` con `handledBy: battery-mqtt`** → errore Modbus in scrittura (`[write-reg-400] Timed out`, `Modbus port unavailable`) o valore fuori range.
6. **ACK `ok` ma lo stato non cambia come atteso** → il controller ha accettato la scrittura ma applica una propria logica (limiti interni, stato che non consente la modifica). Consultare la documentazione del controller.

### MariaDB: `Access denied` o `Unknown database`

- Verificare credenziali e host in `.env`.
- L'utente deve avere il privilegio `CREATE` sul database, perché all'avvio viene eseguito `CREATE DATABASE IF NOT EXISTS` (vedi [installazione.md](installazione.md#mariadb)).
- Prova manuale: `mariadb -h <host> -u <utente> -p sensor_data`.

### MQTT: `Connection refused: Not authorized` / `Bad username or password`

Credenziali `MQTT_USERNAME` / `MQTT_PASSWORD` errate o assenti, oppure il broker non consente l'accesso anonimo. Verificare con:

```bash
mosquitto_sub -h <host> -u <utente> -P <password> -t '#' -C 1
```

### La dashboard remota non si collega

- Il nome host `iot-edge-1` potrebbe non essere risolvibile dal PC: impostare `MQTT_BROKER=mqtt://<ip>:1883` in `.env`.
- Mosquitto dalla versione 2 accetta connessioni solo da `localhost` se non è configurato un `listener` esplicito (vedi [installazione.md](installazione.md#broker-mqtt-mosquitto)).
- Firewall sulla porta 1883.

### Le due dashboard mostrano caratteri strani

Il terminale deve supportare i codici ANSI e UTF-8. Su Windows usare Windows Terminal o PowerShell recente, non il vecchio `cmd.exe`.

### Gli orari nel database non coincidono con quelli dei messaggi MQTT

È atteso: MQTT usa UTC, il database l'ora locale del Raspberry. Vedi [riferimento.md](riferimento.md#note-sul-fuso-orario).

## Strumenti di diagnosi

### Esecuzione in primo piano

```bash
sudo systemctl stop raspi-battery
npm run battery
# … osservare l'output, Ctrl+C per uscire …
sudo systemctl start raspi-battery
```

### Filtrare i log

```bash
# solo errori e avvisi
journalctl -u raspi-labsens -f | grep -E '\[(ERROR|WARN|FATAL)\]'

# esiti dell'autodetect
journalctl -u raspi-battery | grep AUTODETECT

# comandi eseguiti oggi
journalctl -u raspi-battery --since today | grep -E '\[CMD'
```

### Chi sta usando una porta seriale

```bash
sudo fuser -v /dev/ttyUSB0 /dev/ttyUSB1
```

### Verificare l'ultimo inserimento nel database

```sql
SELECT MAX(recorded_at) FROM labsens_measurements;
SELECT MAX(recorded_at) FROM battery_measurements;
```

## Limitazioni note

| Area | Limitazione |
|---|---|
| Sensori di laboratorio | I registri 64–69 e 34 sono interpretati **senza segno**: una temperatura negativa inviata in complemento a due verrebbe letta come un valore molto alto (es. −1,00 °C → 655,35 °C). |
| Sensori di laboratorio | Il topic base `sensors/lab` è fisso nel codice di `labsens-mqtt.js` e `dashboard.js`. |
| Sensori di laboratorio | I messaggi non sono `retain`: un client che si collega non riceve l'ultimo valore finché non arriva il ciclo successivo. |
| Sensori di laboratorio | Il `timestamp` MQTT e `recorded_at` nel DB sono generati al momento della pubblicazione/inserimento, non della lettura Modbus (differenza di pochi millisecondi). |
| Dashboard sensori | La soglia `(stale)` è fissa a 15 s e le scale delle barre sono definite nel codice. |
| Controller batteria | Le informazioni del controller (`meta`) sono lette solo all'avvio del servizio. |
| Controller batteria | Un errore di scrittura su MariaDB conta come ciclo fallito: se il database resta irraggiungibile per `BATTERY_MAX_FAILURES` cicli, la porta seriale viene chiusa e riaperta con un nuovo autodetect, anche se il dispositivo funziona. |
| Controller batteria | Nessun limite software sui setpoint di corrente e tensione. |
| Comandi | Un JSON non valido su `command/request` viene scartato senza ACK. |
| Autodetect | I dispositivi sono distinti **solo per indirizzo Modbus**: due dispositivi con lo stesso indirizzo su adattatori diversi non sono distinguibili. |
| Installazione | `setup-systemd-services.sh` contiene percorso del progetto e utente scritti nel codice. |
| Database | Nessuna politica di conservazione automatica: le tabelle crescono indefinitamente (vedi [utilizzo.md](utilizzo.md#volume-dei-dati)). |
| Test | Il progetto non include test automatici. |

## Note di sicurezza

- **Credenziali**: `.env` contiene le password di MQTT e MariaDB. È escluso da git; proteggerlo anche sul filesystem: `chmod 600 .env`.
- **Controllo di accesso ai comandi**: chiunque possa pubblicare sul broker può comandare il controller batteria, incluso il comando `write_register` che scrive qualsiasi registro. Inoltre è possibile pubblicare direttamente su `command/dispatch`, saltando la validazione del bridge. Si raccomanda di configurare in Mosquitto delle **ACL** che:
  - consentano la scrittura su `sensors/battery/command/request` solo agli utenti autorizzati;
  - consentano la scrittura su `sensors/battery/command/dispatch` solo all'utente del bridge;
  - consentano la scrittura su `sensors/+/…` (telemetria) solo agli utenti dei servizi.

  Esempio (`/etc/mosquitto/acl`, referenziato con `acl_file` nella configurazione):

  ```
  user raspi-services
  topic write sensors/#
  topic read sensors/#

  user operatore
  topic read sensors/#
  topic write sensors/battery/command/request

  user dashboard
  topic read sensors/#
  ```

  Per applicare queste ACL occorre usare utenti MQTT distinti per i servizi e per i client (attualmente tutti leggono le stesse `MQTT_USERNAME`/`MQTT_PASSWORD` da `.env`).
- **Rete**: il traffico MQTT è in chiaro su `mqtt://`. Se il broker è esposto oltre la rete di laboratorio, abilitare TLS (`mqtts://`, porta 8883).
- **Database**: i nomi di database e tabelle presi dalle variabili d'ambiente sono inseriti nel SQL senza escape; le variabili d'ambiente vanno quindi considerate configurazione fidata. I valori delle misure, invece, sono inseriti con query parametrizzate.
