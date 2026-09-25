# Guida all'utilizzo

Questa guida è rivolta a chi usa il sistema: consultare le misure, comandare il controller batteria, interrogare lo storico.

- [Dashboard sensori di laboratorio](#dashboard-sensori-di-laboratorio)
- [Dashboard e comandi batteria](#dashboard-e-comandi-batteria)
- [Inviare comandi senza dashboard](#inviare-comandi-senza-dashboard)
- [Leggere i dati con un client MQTT qualsiasi](#leggere-i-dati-con-un-client-mqtt-qualsiasi)
- [Consultare lo storico su MariaDB](#consultare-lo-storico-su-mariadb)
- [Integrazione con altri sistemi](#integrazione-con-altri-sistemi)

---

## Dashboard sensori di laboratorio

```bash
npm run dashboard
```

Esempio di schermata:

```
  LAB SENSOR DASHBOARD                                      14:32:05
  Broker: mqtt://localhost:1883   Status: ● CONNECTED   Messages received: 1284
───────────────────────────────────────────────────────────────────────────
  Sensor                     Value  Unit    Bar (min→max)              Last update
───────────────────────────────────────────────────────────────────────────
  Temperature                23.41  °C      ███████░░░░░░░░░░░░░  14:32:05
  Humidity                   45.20  %       █████████░░░░░░░░░░░  14:32:05
  PM10                       12.00  µg/m³   ░░░░░░░░░░░░░░░░░░░░  14:32:05
  PM2.5                       8.00  µg/m³   █░░░░░░░░░░░░░░░░░░░  14:32:05
  VOC                       102.00  ppb     ██░░░░░░░░░░░░░░░░░░  14:32:05
  NOx                         1.00  ppb     ░░░░░░░░░░░░░░░░░░░░  14:32:05
  NTC Temp                    23.8  °C      ███████░░░░░░░░░░░░░  14:32:05
───────────────────────────────────────────────────────────────────────────
  Press Ctrl+C to exit
```

Come leggerla:

- **Status**: `● CONNECTED` (verde) o `○ DISCONNECTED` (rosso). In caso di disconnessione il client si ricollega da solo ogni 3 s.
- **Messages received**: numero di messaggi validi ricevuti dall'avvio.
- **Bar**: posizione del valore nell'intervallo di scala:

  | Grandezza | Scala |
  |---|---|
  | Temperature, NTC Temp | −10 … 60 °C |
  | Humidity | 0 … 100 % |
  | PM10 | 0 … 500 µg/m³ |
  | PM2.5 | 0 … 300 µg/m³ |
  | VOC, NOx | 0 … 1000 ppb |

  Colore: **verde** sotto il 50 % della scala, **giallo** fra 50 % e 80 %, **rosso** oltre l'80 %. La barra è un'indicazione visiva e non corrisponde a soglie di allarme normative.
- **waiting for data…**: nessun valore ancora ricevuto per quella grandezza (i messaggi dei sensori di laboratorio non sono conservati dal broker, quindi i valori compaiono al primo ciclo di polling dopo la connessione).
- **(stale)** in giallo: l'ultimo valore ha più di 15 secondi, cioè il servizio `raspi-labsens` non sta pubblicando (servizio fermo, dispositivo non raggiungibile, errori di lettura).

Uscita: `Ctrl+C`.

## Dashboard e comandi batteria

```bash
npm run battery-remote
```

> Se `MQTT_BROKER` non è impostata, questa dashboard si collega per default a `mqtt://iot-edge-1:1883` (nome host del Raspberry di laboratorio), non a `localhost`.

Esempio di schermata:

```
 BATTERY REMOTE DASHBOARD                      14:35:12
 Broker: mqtt://iot-edge-1:1883
 Status: CONNECTED   Messages: 57
----------------------------------------------------------------------------
 Battery state
 Current setpoint: 1500 mA          Voltage setpoint: 4200 mV
 Current measured: 1487 mA          Voltage measured: 3912 mV
 Run state: charge                  Battery type: 1
 Last update: 2026-09-25T12:35:12.114Z

 Controller info
 Address: 4   Firmware: 103   Device: 17

 Last command ACK
 OK cmd=set_current_ma id=mfz3k1-a1b2c3
 message=set_current_ma applied on register 400 time=2026-09-25T12:35:10.902Z
----------------------------------------------------------------------------
 Commands:
  current <mA>      -> set current setpoint register 400
  voltage <mV>      -> set voltage setpoint register 401
  run <0|1|2>       -> set run state register 404
  raw <reg> <value> -> raw write single register
  help              -> print command help
  quit              -> exit dashboard
cmd>
```

### Sezioni

- **Battery state**: ultimo stato pubblicato dal servizio `raspi-battery`. Grazie ai messaggi `retain` compare subito alla connessione, anche se il servizio è fermo: in quel caso controllare **Last update** per capire quanto è vecchio il dato.
- **Controller info**: indirizzo Modbus, versione firmware e codice dispositivo letti all'avvio del servizio.
- **Last command ACK**: esito dell'ultimo comando ricevuto da *qualsiasi* client (in verde `OK`, in rosso `ERROR`), con il messaggio di dettaglio.

### Comandi

| Comando | Effetto | Esempio |
|---|---|---|
| `current <mA>` | Imposta il setpoint di corrente (registro 400) | `current 1500` |
| `voltage <mV>` | Imposta il setpoint di tensione (registro 401) | `voltage 4200` |
| `run <0\|1\|2>` | Imposta lo stato di marcia (registro 404): `0` = stop, `1` = carica, `2` = scarica | `run 1` |
| `raw <reg> <valore>` | Scrive un valore arbitrario in un registro qualsiasi | `raw 405 2` |
| `help` | Mostra l'elenco dei comandi | |
| `quit` / `exit` | Esce dalla dashboard | |

I valori devono essere **interi** (mA, mV). Per `current`, `voltage` e `raw` sono accettati valori da −32768 a 65535; i valori negativi vengono scritti in complemento a due.

### Sequenza tipica: avviare una carica

```
cmd> run 0            # assicurarsi che il controller sia fermo
cmd> voltage 4200     # tensione di fine carica 4,2 V
cmd> current 1000     # corrente di carica 1 A
cmd> run 1            # avvio della carica
...
cmd> run 0            # arresto
```

Dopo ogni comando attendere l'ACK `OK` e verificare in **Battery state** che il setpoint sia stato recepito.

### Cosa succede dopo l'invio

1. La riga `[CMD] Sent set_current_ma (id=…)` conferma che il comando è stato pubblicato sul broker.
2. Il bridge lo valida e lo inoltra al servizio batteria.
3. Il servizio scrive il registro, rilegge lo stato e pubblica l'ACK.
4. La dashboard mostra l'ACK e lo stato aggiornato.

Se l'ACK non arriva entro pochi secondi, vedere [troubleshooting.md](troubleshooting.md#i-comandi-alla-batteria-non-hanno-effetto).

> **Attenzione:** il comando `raw` scrive direttamente nei registri del controller senza alcun controllo sul significato del valore. Usarlo solo conoscendo la mappa registri del dispositivo (vedi [riferimento.md](riferimento.md#controller-batteria-indirizzo-4)). Allo stesso modo, i setpoint di corrente e tensione non sono limitati dal software: è responsabilità dell'utente rispettare i limiti della batteria collegata.

## Inviare comandi senza dashboard

Qualsiasi client MQTT può inviare comandi pubblicando un JSON su `sensors/battery/command/request`. Con i client di Mosquitto:

```bash
# in un terminale: seguire gli ACK
mosquitto_sub -h localhost -u utente_mqtt -P password_mqtt \
  -t 'sensors/battery/command/ack' -v

# in un altro terminale: inviare un comando
mosquitto_pub -h localhost -u utente_mqtt -P password_mqtt -q 1 \
  -t 'sensors/battery/command/request' \
  -m '{"commandId":"test-001","command":"set_current_ma","value":1500}'
```

Altri esempi di payload:

```json
{"commandId":"test-002","command":"set_voltage_mv","value":4200}
{"commandId":"test-003","command":"set_run_state","value":0}
{"commandId":"test-004","command":"write_register","register":405,"value":2}
```

Il campo `commandId` è obbligatorio: usare un valore univoco per poter riconoscere il relativo ACK. Il formato completo è descritto in [riferimento.md](riferimento.md#comandi-batteria).

## Leggere i dati con un client MQTT qualsiasi

```bash
# tutti i sensori di laboratorio
mosquitto_sub -h localhost -u utente_mqtt -P password_mqtt -t 'sensors/lab/#' -v

# stato completo della batteria
mosquitto_sub -h localhost -u utente_mqtt -P password_mqtt -t 'sensors/battery/state' -v

# tutto
mosquitto_sub -h localhost -u utente_mqtt -P password_mqtt -t 'sensors/#' -v
```

Output tipico:

```
sensors/lab/temperature {"value":23.41,"unit":"°C","timestamp":"2026-09-25T12:32:05.123Z","sensor":"temperature"}
sensors/battery/voltage-measured {"value":3912,"unit":"mV","timestamp":"2026-09-25T12:35:12.114Z","sensor":"voltageMeasuredMv"}
```

Sono adatti anche client grafici come MQTT Explorer.

## Consultare lo storico su MariaDB

```bash
mariadb -u mceserani -p sensor_data
```

Ultime 10 misure ambientali:

```sql
SELECT recorded_at, temperature, humidity, pm10, pm2_5, voc, nox, ntc_temperature
FROM labsens_measurements
ORDER BY recorded_at DESC
LIMIT 10;
```

Medie orarie delle ultime 24 ore:

```sql
SELECT DATE_FORMAT(recorded_at, '%Y-%m-%d %H:00') AS ora,
       ROUND(AVG(temperature), 2) AS temp_media,
       ROUND(AVG(humidity), 2)    AS umid_media,
       ROUND(MAX(pm2_5), 2)       AS pm25_max
FROM labsens_measurements
WHERE recorded_at >= NOW() - INTERVAL 1 DAY
GROUP BY ora
ORDER BY ora;
```

Andamento di una sessione di carica:

```sql
SELECT recorded_at, run_state_label, current_measured_ma, voltage_measured_mv
FROM battery_measurements
WHERE recorded_at BETWEEN '2026-09-25 10:00' AND '2026-09-25 12:00'
  AND run_state = 1
ORDER BY recorded_at;
```

Carica accumulata approssimata (mAh) in un intervallo, integrando la corrente sui campioni (valida con polling a 1 s):

```sql
SELECT ROUND(SUM(current_measured_ma) / 3600, 1) AS mAh
FROM battery_measurements
WHERE recorded_at BETWEEN '2026-09-25 10:00' AND '2026-09-25 12:00';
```

Esportazione in CSV:

```bash
mariadb -u mceserani -p sensor_data -B -e \
  "SELECT * FROM labsens_measurements WHERE recorded_at >= CURDATE()" \
  | tr '\t' ',' > labsens_oggi.csv
```

### Volume dei dati

Con polling a 1 s ogni servizio inserisce circa **86 400 righe al giorno** (~31 milioni l'anno). Per conservare lo spazio si può pianificare una pulizia periodica, ad esempio con l'event scheduler di MariaDB:

```sql
SET GLOBAL event_scheduler = ON;

CREATE EVENT IF NOT EXISTS purge_old_measurements
ON SCHEDULE EVERY 1 DAY
DO BEGIN
  DELETE FROM labsens_measurements WHERE recorded_at < NOW() - INTERVAL 90 DAY;
  DELETE FROM battery_measurements WHERE recorded_at < NOW() - INTERVAL 90 DAY;
END;
```

In alternativa aumentare `LABSENS_POLL_INTERVAL` / `BATTERY_POLL_INTERVAL`.

## Integrazione con altri sistemi

Poiché tutti i dati passano dal broker MQTT con payload JSON semplici, il sistema si integra facilmente con:

- **Node-RED**: nodo `mqtt in` sul topic desiderato + nodo `json`.
- **Home Assistant**: sensori MQTT con `value_template: "{{ value_json.value }}"`.
- **Grafana**: sorgente dati MySQL/MariaDB puntata sul database `sensor_data`, con `recorded_at` come colonna temporale.
- **Telegraf / InfluxDB**: input `mqtt_consumer` con `data_format = "json"`.
