# Riferimento tecnico

- [Topic MQTT](#topic-mqtt)
  - [Sensori di laboratorio](#sensori-di-laboratorio)
  - [Batteria — telemetria](#batteria--telemetria)
  - [Comandi batteria](#comandi-batteria)
- [Mappa registri Modbus](#mappa-registri-modbus)
- [Schema del database](#schema-del-database)
- [Formato dei log](#formato-dei-log)

---

## Topic MQTT

### Riepilogo

| Topic | Direzione | QoS | Retain | Pubblicato da |
|---|---|---|---|---|
| `sensors/lab/temperature` | → | 0 | no | labsens-mqtt |
| `sensors/lab/humidity` | → | 0 | no | labsens-mqtt |
| `sensors/lab/pm10` | → | 0 | no | labsens-mqtt |
| `sensors/lab/pm2_5` | → | 0 | no | labsens-mqtt |
| `sensors/lab/voc` | → | 0 | no | labsens-mqtt |
| `sensors/lab/nox` | → | 0 | no | labsens-mqtt |
| `sensors/lab/ntc/temperature` | → | 0 | no | labsens-mqtt |
| `sensors/battery/meta` | → | 0 | **sì** | battery-mqtt (all'avvio) |
| `sensors/battery/state` | → | 0 | **sì** | battery-mqtt |
| `sensors/battery/current-setpoint` | → | 0 | **sì** | battery-mqtt |
| `sensors/battery/voltage-setpoint` | → | 0 | **sì** | battery-mqtt |
| `sensors/battery/current-measured` | → | 0 | **sì** | battery-mqtt |
| `sensors/battery/voltage-measured` | → | 0 | **sì** | battery-mqtt |
| `sensors/battery/run-state` | → | 0 | **sì** | battery-mqtt |
| `sensors/battery/run-state-label` | → | 0 | **sì** | battery-mqtt |
| `sensors/battery/battery-type` | → | 0 | **sì** | battery-mqtt |
| `sensors/battery/command/request` | ← | 1 | no | client (dashboard, altri) |
| `sensors/battery/command/dispatch` | interno | 1 | no | battery-cmd-bridge |
| `sensors/battery/command/ack` | → | 1 | no | battery-cmd-bridge, battery-mqtt |

Il prefisso `sensors/battery` è configurabile con `BATTERY_MQTT_TOPIC`; `sensors/lab` è fisso.

Frequenza: con polling a 1 s il servizio labsens pubblica 7 messaggi/s e il servizio batteria 8 messaggi/s.

### Sensori di laboratorio

Ogni grandezza è pubblicata su un topic separato con payload:

```json
{
  "value": 23.41,
  "unit": "°C",
  "timestamp": "2026-09-25T12:32:05.123Z",
  "sensor": "temperature"
}
```

| Campo | Tipo | Descrizione |
|---|---|---|
| `value` | number | Valore già convertito in unità fisiche |
| `unit` | string | Unità di misura |
| `timestamp` | string | Istante di pubblicazione, ISO 8601 UTC |
| `sensor` | string | Nome della grandezza |

| Topic | `sensor` | `unit` |
|---|---|---|
| `sensors/lab/temperature` | `temperature` | `°C` |
| `sensors/lab/humidity` | `humidity` | `%` |
| `sensors/lab/pm10` | `pm10` | `µg/m³` |
| `sensors/lab/pm2_5` | `pm2_5` | `µg/m³` |
| `sensors/lab/voc` | `voc` | `ppb` |
| `sensors/lab/nox` | `nox` | `ppb` |
| `sensors/lab/ntc/temperature` | `ntc_temperature` | `°C` |

### Batteria — telemetria

#### `sensors/battery/meta`

Informazioni sul controller, lette e pubblicate una sola volta all'avvio del servizio (retain).

```json
{
  "firmwareVersion": 103,
  "controllerAddress": 4,
  "deviceCode": 17,
  "baudRate": 115200,
  "baudRateCode": 12,
  "port": "/dev/serial/by-id/usb-FTDI_LC231X_FT603T6A-if00-port0",
  "polledAt": "2026-09-25T08:00:01.512Z"
}
```

| Campo | Descrizione |
|---|---|
| `firmwareVersion` | Registro 0, valore grezzo |
| `controllerAddress` | Registro 1, indirizzo Modbus configurato nel controller |
| `deviceCode` | Registro 8, codice identificativo del dispositivo |
| `baudRateCode` | Registro 13, valore grezzo |
| `baudRate` | `baudRateCode × 9600` |
| `port` | Porta seriale su cui il controller è stato trovato |
| `polledAt` | Istante della lettura |

#### `sensors/battery/state`

Stato completo, pubblicato a ogni ciclo e dopo ogni comando (retain).

```json
{
  "currentSetpointMa": 1500,
  "voltageSetpointMv": 4200,
  "currentMeasuredMa": 1487,
  "voltageMeasuredMv": 3912,
  "runState": 1,
  "runStateLabel": "charge",
  "batteryType": 1,
  "timestamp": "2026-09-25T12:35:12.114Z",
  "controller": {
    "firmwareVersion": 103,
    "controllerAddress": 4,
    "deviceCode": 17,
    "baudRate": 115200
  }
}
```

| Campo | Tipo | Registro | Descrizione |
|---|---|---|---|
| `currentSetpointMa` | int (con segno) | 400 | Setpoint di corrente, mA |
| `voltageSetpointMv` | int (con segno) | 401 | Setpoint di tensione, mV |
| `currentMeasuredMa` | int (con segno) | 402 | Corrente misurata, mA |
| `voltageMeasuredMv` | int (con segno) | 403 | Tensione misurata, mV |
| `runState` | int | 404 | `0` fermo, `1` carica, `2` scarica |
| `runStateLabel` | string | — | `stopped`, `charge`, `discharge`, oppure `unknown` per altri valori |
| `batteryType` | int | 405 | Codice del tipo di batteria (significato definito dal firmware del controller) |
| `timestamp` | string | — | Istante della lettura, ISO 8601 UTC |
| `controller` | object | — | Sottoinsieme di `meta` |

#### Topic per singola grandezza

Stesso formato dei sensori di laboratorio (`value`, `unit`, `timestamp`, `sensor`):

| Topic | `sensor` | `unit` |
|---|---|---|
| `sensors/battery/current-setpoint` | `currentSetpointMa` | `mA` |
| `sensors/battery/voltage-setpoint` | `voltageSetpointMv` | `mV` |
| `sensors/battery/current-measured` | `currentMeasuredMa` | `mA` |
| `sensors/battery/voltage-measured` | `voltageMeasuredMv` | `mV` |
| `sensors/battery/run-state` | `runState` | `code` |
| `sensors/battery/run-state-label` | `runStateLabel` | `label` (valore stringa) |
| `sensors/battery/battery-type` | `batteryType` | `code` |

### Comandi batteria

#### Richiesta — `sensors/battery/command/request`

```json
{
  "commandId": "mfz3k1-a1b2c3",
  "command": "set_current_ma",
  "value": 1500,
  "source": "battery-remote-dashboard",
  "timestamp": "2026-09-25T12:35:10.771Z"
}
```

| Campo | Obbligatorio | Descrizione |
|---|---|---|
| `commandId` | sì | Stringa non vuota scelta dal client, restituita nell'ACK |
| `command` | sì | Uno dei comandi sotto |
| `value` | sì | Intero |
| `register` | solo per `write_register` | Intero, indirizzo del registro |
| `source`, `timestamp`, altri | no | Informativi; vengono inoltrati così come sono |

| `command` | Registro scritto | Valori ammessi |
|---|---|---|
| `set_current_ma` | 400 | intero −32768…65535 |
| `set_voltage_mv` | 401 | intero −32768…65535 |
| `set_run_state` | 404 | `0`, `1`, `2` |
| `write_register` | `register` | intero −32768…65535 |

I valori possono essere inviati anche come stringhe numeriche (`"1500"`): vengono convertiti con `Number()`.

#### Inoltro — `sensors/battery/command/dispatch`

Topic interno fra bridge e servizio batteria. Contiene il payload della richiesta più:

```json
{
  "forwardedBy": "battery-cmd-bridge",
  "forwardedAt": "2026-09-25T12:35:10.790Z"
}
```

Normalmente i client non devono pubblicare su questo topic. Il servizio batteria esegue comunque una propria validazione, ma non richiede `commandId`.

#### Esito — `sensors/battery/command/ack`

Successo (da `battery-mqtt`):

```json
{
  "status": "ok",
  "message": "set_current_ma applied on register 400",
  "command": "set_current_ma",
  "commandId": "mfz3k1-a1b2c3",
  "register": 400,
  "value": 1500,
  "timestamp": "2026-09-25T12:35:10.902Z",
  "handledBy": "battery-mqtt"
}
```

Errore:

```json
{
  "status": "error",
  "message": "set_run_state supports only 0, 1 or 2",
  "command": "set_run_state",
  "commandId": "mfz3k1-d4e5f6",
  "timestamp": "2026-09-25T12:36:00.010Z",
  "handledBy": "battery-cmd-bridge"
}
```

`handledBy` indica dove è stato rilevato l'errore:

| `handledBy` | Significato | Messaggi tipici |
|---|---|---|
| `battery-cmd-bridge` | Richiesta rifiutata in validazione, **nessuna scrittura** è stata tentata | `Unsupported command: …`, `commandId is required and must be a string`, `… requires integer value`, `set_run_state supports only 0, 1 or 2`, `Failed to forward command: …` |
| `battery-mqtt` | Errore durante l'esecuzione (la scrittura potrebbe essere avvenuta o meno) | `[write-reg-400] Timed out`, `Value out of 16-bit range: …`, `Modbus port unavailable`, `Battery state read timeout` |

Una richiesta con **JSON non valido** su `command/request` viene scartata dal bridge senza ACK.

---

## Mappa registri Modbus

Protocollo: **Modbus RTU** su RS-485. Letture con funzione **03** (Read Holding Registers) e fallback automatico sulla **04** (Read Input Registers); scritture con funzione **06** (Write Single Register). Tutti i registri sono a 16 bit.

### Scheda sensori (indirizzo 29)

| Registro | Grandezza | Conversione | Unità |
|---|---|---|---|
| 34 | Temperatura NTC | grezzo ÷ 10 | °C |
| 64 | Temperatura | grezzo ÷ 100 | °C |
| 65 | Umidità relativa | grezzo ÷ 100 | % |
| 66 | PM10 | grezzo ÷ 100 | µg/m³ |
| 67 | PM2.5 | grezzo ÷ 100 | µg/m³ |
| 68 | VOC | grezzo ÷ 100 | ppb |
| 69 | NOx | grezzo ÷ 100 | ppb |

Lettura per ciclo: una richiesta per 64–69 (6 registri) e una per 34 (1 registro). Il registro 64 è usato come sonda dall'autodetect.

### Controller batteria (indirizzo 4)

| Registro | Nome | Accesso dal software | Interpretazione |
|---|---|---|---|
| 0 | Versione firmware | lettura all'avvio, sonda autodetect | grezzo |
| 1 | Indirizzo controller | lettura all'avvio | grezzo |
| 8 | Codice dispositivo | lettura all'avvio | grezzo |
| 13 | Codice baud rate | lettura all'avvio | × 9600 = baud |
| 400 | Setpoint corrente | lettura ciclica, scrittura (`set_current_ma`) | int16 con segno, mA |
| 401 | Setpoint tensione | lettura ciclica, scrittura (`set_voltage_mv`) | int16 con segno, mV |
| 402 | Corrente misurata | lettura ciclica | int16 con segno, mA |
| 403 | Tensione misurata | lettura ciclica | int16 con segno, mV |
| 404 | Stato di marcia | lettura ciclica, scrittura (`set_run_state`) | 0 fermo, 1 carica, 2 scarica |
| 405 | Tipo batteria | lettura ciclica | codice |

Lettura per ciclo: una richiesta per 400–405 (6 registri). Con `write_register` è possibile scrivere qualsiasi altro registro.

---

## Schema del database

Database: `sensor_data` (configurabile con `MARIADB_DATABASE`). Database e tabelle vengono creati automaticamente all'avvio dei servizi se non esistono.

### Tabella `labsens_measurements`

Una riga per ciclo di polling riuscito.

```sql
CREATE TABLE IF NOT EXISTS labsens_measurements (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  recorded_at DATETIME(3) NOT NULL,
  temperature DOUBLE,
  humidity DOUBLE,
  pm10 DOUBLE,
  pm2_5 DOUBLE,
  voc DOUBLE,
  nox DOUBLE,
  ntc_temperature DOUBLE,
  PRIMARY KEY (id),
  INDEX idx_recorded_at (recorded_at)
);
```

| Colonna | Descrizione |
|---|---|
| `id` | Chiave progressiva |
| `recorded_at` | Istante dell'inserimento, con millisecondi |
| `temperature` … `nox` | Valori convertiti (stesse unità dei topic MQTT) |
| `ntc_temperature` | Temperatura NTC, °C |

### Tabella `battery_measurements`

Una riga per ciclo di polling riuscito **e** una per ogni comando eseguito con successo (stato riletto dopo la scrittura).

```sql
CREATE TABLE IF NOT EXISTS battery_measurements (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  recorded_at DATETIME(3) NOT NULL,
  current_setpoint_ma INT,
  voltage_setpoint_mv INT,
  current_measured_ma INT,
  voltage_measured_mv INT,
  run_state TINYINT,
  run_state_label VARCHAR(32),
  battery_type INT,
  controller_address INT NULL,
  device_code INT NULL,
  firmware_version INT NULL,
  PRIMARY KEY (id),
  INDEX idx_recorded_at (recorded_at)
);
```

| Colonna | Descrizione |
|---|---|
| `recorded_at` | Istante della lettura Modbus, con millisecondi |
| `current_setpoint_ma`, `voltage_setpoint_mv` | Setpoint (registri 400, 401) |
| `current_measured_ma`, `voltage_measured_mv` | Misure (registri 402, 403) |
| `run_state`, `run_state_label` | Stato di marcia, codice ed etichetta |
| `battery_type` | Registro 405 |
| `controller_address`, `device_code`, `firmware_version` | Dati del controller letti all'avvio del servizio |

### Note sul fuso orario

Le colonne `recorded_at` sono di tipo `DATETIME` (senza fuso orario). Il connettore `mariadb` converte le date JavaScript usando il fuso orario locale del processo, quindi i valori sono memorizzati nell'**ora locale del Raspberry** (verificabile con `timedatectl`). I `timestamp` nei payload MQTT, invece, sono sempre in **UTC** (suffisso `Z`). Tenerne conto quando si confrontano le due fonti o quando cambia l'ora legale.

---

## Formato dei log

Tutti i processi scrivono su stdout/stderr; sotto systemd i messaggi finiscono nel journal. Ogni riga ha un prefisso che ne indica la natura:

| Prefisso | Significato |
|---|---|
| `[INFO]` | Fasi di avvio e arresto |
| `[✓]` | Operazione completata (connessione riuscita, chiusura) |
| `[POLL]` | Ciclo di polling (inizio, tick saltati, cicli scartati) |
| `[DATA]` | Valori letti nel ciclo |
| `[DEBUG]` | Registri grezzi e dettagli delle letture |
| `[MQTT]` | Pubblicazione avvenuta |
| `[MariaDB]` | Riga salvata |
| `[CMD]` | Comando inoltrato (bridge) o applicato (servizio batteria) |
| `[CMD ERROR]` | Errore nell'esecuzione di un comando |
| `[AUTODETECT]` | Esito della scansione delle porte seriali |
| `[WARN]` | Anomalia gestita (fallback 03→04, riconnessione, re-detect) |
| `[ERROR]` | Errore di un'operazione; il servizio prosegue |
| `[FATAL]` | Errore che causa la terminazione del processo |

Con polling a 1 s i servizi producono diverse righe al secondo. Per contenere l'occupazione del journal si può impostare, ad esempio, `SystemMaxUse=200M` in `/etc/systemd/journald.conf`.
