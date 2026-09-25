# Installazione e configurazione

- [Prerequisiti](#prerequisiti)
- [Hardware e collegamenti](#hardware-e-collegamenti)
- [Preparazione del sistema](#preparazione-del-sistema)
- [Installazione del software](#installazione-del-software)
- [Configurazione (`.env`)](#configurazione-env)
- [Installazione come servizi systemd](#installazione-come-servizi-systemd)
- [Esecuzione manuale](#esecuzione-manuale)
- [Installazione delle dashboard su un PC remoto](#installazione-delle-dashboard-su-un-pc-remoto)
- [Aggiornamento](#aggiornamento)

---

## Prerequisiti

| Componente | Versione / note |
|---|---|
| Sistema operativo | Raspberry Pi OS (o altra distribuzione Linux con systemd) |
| Node.js | **≥ 20.6** — necessario per l'opzione `--env-file`. Verificare con `node --version`. |
| npm | incluso con Node.js |
| Broker MQTT | es. Mosquitto, sulla stessa macchina o raggiungibile in rete |
| MariaDB | 10.x o successiva (anche MySQL compatibile), sulla stessa macchina o in rete |
| Adattatori seriali | USB ↔ RS-485, uno per ciascun dispositivo |

## Hardware e collegamenti

- Collegare la **scheda sensori** e il **controller batteria** ciascuno al proprio adattatore USB ↔ RS-485.
- Parametri di linea di default: **115200 baud**, 8 bit, nessuna parità, 1 bit di stop (8N1, default di `modbus-serial`).
- Indirizzi slave di default: **29** per la scheda sensori, **4** per il controller batteria. Due dispositivi sulla stessa macchina devono avere indirizzi diversi, perché è l'indirizzo che permette all'autodetect di distinguerli.

Dopo il collegamento gli adattatori devono comparire in `/dev/serial/by-id/`:

```bash
ls -l /dev/serial/by-id/
# usb-FTDI_LC231X_FT603S4Q-if00-port0 -> ../../ttyUSB0
# usb-FTDI_LC231X_FT603T6A-if00-port0 -> ../../ttyUSB1
```

Il software usa **solo** questa cartella: gli adattatori che non vi compaiono non vengono presi in considerazione dall'autodetect.

## Preparazione del sistema

### Node.js

```bash
sudo apt update
sudo apt install -y nodejs npm
node --version    # deve essere >= 20.6
```

Se la versione della distribuzione è troppo vecchia, installare Node.js da NodeSource o tramite `nvm`.

### Permessi sulla seriale

L'utente che esegue i servizi deve appartenere al gruppo `dialout`:

```bash
sudo usermod -aG dialout $USER
# effettuare logout/login per rendere effettiva l'appartenenza
```

(Le unità systemd create dallo script impostano comunque `SupplementaryGroups=dialout`.)

### Broker MQTT (Mosquitto)

```bash
sudo apt install -y mosquitto mosquitto-clients
```

Per abilitare l'autenticazione e l'accesso dalla rete, creare ad esempio `/etc/mosquitto/conf.d/raspi.conf`:

```
listener 1883
allow_anonymous false
password_file /etc/mosquitto/passwd
```

e creare l'utente:

```bash
sudo mosquitto_passwd -c /etc/mosquitto/passwd utente_mqtt
sudo systemctl restart mosquitto
```

### MariaDB

```bash
sudo apt install -y mariadb-server
sudo mariadb
```

```sql
CREATE USER 'mceserani'@'localhost' IDENTIFIED BY 'password_db';
-- include il privilegio CREATE su sensor_data, necessario perché
-- all'avvio il servizio esegue CREATE DATABASE IF NOT EXISTS sensor_data
GRANT ALL PRIVILEGES ON sensor_data.* TO 'mceserani'@'localhost';
FLUSH PRIVILEGES;
```

Il database e le tabelle vengono creati **automaticamente** al primo avvio dei servizi; non è necessario eseguire script SQL. Se si usa un nome di database diverso da `sensor_data` (variabile `MARIADB_DATABASE`), adeguare il `GRANT` di conseguenza.

Se il database si trova su un'altra macchina, usare `'utente'@'%'` (o l'indirizzo del Raspberry) e verificare che MariaDB ascolti sull'interfaccia di rete (`bind-address` in `/etc/mysql/mariadb.conf.d/50-server.cnf`).

## Installazione del software

```bash
cd ~
git clone git@github.com:mceserani/Raspi-MQTT.git
cd Raspi-MQTT
npm install
```

## Configurazione (`.env`)

Tutta la configurazione avviene tramite variabili d'ambiente, lette dal file `.env` nella cartella del progetto (caricato da Node con `--env-file=.env`). Il file è escluso da git perché contiene credenziali.

### Esempio completo

```ini
# ── MQTT ─────────────────────────────────────────────
MQTT_BROKER=mqtt://localhost:1883
MQTT_USERNAME=utente_mqtt
MQTT_PASSWORD=password_mqtt

# ── MariaDB ──────────────────────────────────────────
MARIADB_HOST=localhost
MARIADB_PORT=3306
MARIADB_USER=mceserani
MARIADB_PASSWORD=password_db
MARIADB_DATABASE=sensor_data

# ── Scheda sensori di laboratorio ────────────────────
LABSENS_MODBUS_PORT=auto
LABSENS_MODBUS_ADDRESS=29
LABSENS_BAUD_RATE=115200
LABSENS_MODBUS_TIMEOUT=1000
LABSENS_POLL_INTERVAL=1000
LABSENS_MAX_FAILURES=10
LABSENS_DB_TABLE=labsens_measurements

# ── Controller batteria ──────────────────────────────
BATTERY_MODBUS_PORT=auto
BATTERY_MODBUS_ADDRESS=4
BATTERY_BAUD_RATE=115200
BATTERY_MODBUS_TIMEOUT=1000
BATTERY_POLL_INTERVAL=1000
BATTERY_MAX_FAILURES=10
BATTERY_DB_TABLE=battery_measurements
BATTERY_MQTT_TOPIC=sensors/battery
```

Nella pratica è sufficiente specificare le variabili che differiscono dai default: il minimo indispensabile è `MARIADB_PASSWORD` (più le credenziali MQTT se il broker le richiede).

### Variabili comuni

| Variabile | Default | Usata da | Descrizione |
|---|---|---|---|
| `MQTT_BROKER` | `mqtt://localhost:1883` (`mqtt://iot-edge-1:1883` in `battery-remote-dashboard.js`) | tutti | URL del broker. Supporta `mqtt://`, `mqtts://`, `ws://`, `wss://`. |
| `MQTT_USERNAME` | — | tutti | Utente MQTT (omettere se il broker è anonimo). |
| `MQTT_PASSWORD` | — | tutti | Password MQTT. |
| `MARIADB_HOST` | `localhost` | servizi di acquisizione | Host del database. |
| `MARIADB_PORT` | `3306` | servizi di acquisizione | Porta del database. |
| `MARIADB_USER` | `mceserani` | servizi di acquisizione | Utente del database. |
| `MARIADB_PASSWORD` | — (**obbligatoria**) | servizi di acquisizione | Password del database. Se manca, i servizi terminano subito con `[FATAL] MARIADB_PASSWORD is not set`. |
| `MARIADB_DATABASE` | `sensor_data` | servizi di acquisizione | Nome del database (creato se non esiste). |

### Scheda sensori (`labsens-mqtt.js`)

| Variabile | Default | Descrizione |
|---|---|---|
| `LABSENS_MODBUS_PORT` | `auto` | `auto` (o vuota) = ricerca automatica in `/dev/serial/by-id`. Un percorso esplicito (es. `/dev/serial/by-id/usb-FTDI_…`) viene **provato per primo**, ma se il dispositivo non risponde lì la ricerca prosegue sulle altre porte. |
| `LABSENS_MODBUS_ADDRESS` | `29` | Indirizzo slave Modbus della scheda. |
| `LABSENS_BAUD_RATE` | `115200` | Velocità della linea seriale. |
| `LABSENS_MODBUS_TIMEOUT` | `1000` | Timeout di ogni richiesta Modbus (ms). |
| `LABSENS_POLL_INTERVAL` | `1000` | Periodo di polling (ms). |
| `LABSENS_MAX_FAILURES` | `10` | Cicli falliti consecutivi dopo i quali la porta viene chiusa e si ripete l'autodetect. |
| `LABSENS_DB_TABLE` | `labsens_measurements` | Tabella di destinazione (creata se non esiste). |

Il topic base MQTT della scheda sensori è fisso: `sensors/lab`.

### Controller batteria (`battery-mqtt.js`)

| Variabile | Default | Descrizione |
|---|---|---|
| `BATTERY_MODBUS_PORT` | `auto` | Come `LABSENS_MODBUS_PORT`. |
| `BATTERY_MODBUS_ADDRESS` | `4` | Indirizzo slave Modbus del controller. |
| `BATTERY_BAUD_RATE` | `115200` | Velocità della linea seriale. |
| `BATTERY_MODBUS_TIMEOUT` | `1000` | Timeout di ogni richiesta Modbus (ms). |
| `BATTERY_POLL_INTERVAL` | `1000` | Periodo di polling (ms). |
| `BATTERY_MAX_FAILURES` | `10` | Cicli falliti consecutivi prima di ripetere l'autodetect. |
| `BATTERY_DB_TABLE` | `battery_measurements` | Tabella di destinazione. |
| `BATTERY_MQTT_TOPIC` | `sensors/battery` | Topic base. **Deve essere identico** in `battery-mqtt.js`, `battery-cmd-bridge.js` e `battery-remote-dashboard.js`, altrimenti i comandi non arrivano a destinazione. |

### Note sui valori

- I valori numerici non validi (es. `LABSENS_POLL_INTERVAL=abc`) vengono ignorati e sostituiti dal default.
- `MARIADB_DATABASE` e le variabili `*_DB_TABLE` vengono inserite direttamente nelle istruzioni SQL: usare solo nomi semplici (lettere, cifre, underscore).
- Un periodo di polling troppo breve rispetto al timeout (`POLL_INTERVAL` < `2 × TIMEOUT + 500`) non causa sovrapposizioni — i tick in eccesso vengono saltati — ma riempie il log di messaggi `Previous cycle still running`.

## Installazione come servizi systemd

Lo script `setup-systemd-services.sh` automatizza l'installazione dei tre servizi.

> **Attenzione:** all'inizio dello script sono fissati il percorso del progetto e l'utente di servizio:
> ```bash
> PROJECT_DIR="/home/mceserani/Raspi-MQTT"
> SERVICE_USER="mceserani"
> ```
> Se il progetto è installato altrove o con un altro utente, modificare queste due righe prima di eseguirlo.

```bash
./setup-systemd-services.sh
```

Lo script:

1. verifica che `node` sia nel `PATH`, che la cartella del progetto esista, che `.env` esista e contenga `MARIADB_PASSWORD`;
2. se `LABSENS_PORT` / `BATTERY_PORT` sono stati impostati con un percorso, verifica che il file esista;
3. esegue `npm install`;
4. crea (con `sudo`) le unità:

   | Unità | Esegue | Note |
   |---|---|---|
   | `raspi-labsens.service` | `labsens-mqtt.js` | gruppo `dialout`, `LABSENS_MODBUS_PORT` impostata dallo script |
   | `raspi-battery.service` | `battery-mqtt.js` | gruppo `dialout`, `BATTERY_MODBUS_PORT` impostata dallo script |
   | `raspi-battery-cmd-bridge.service` | `battery-cmd-bridge.js` | nessun accesso seriale |

   Tutte partono dopo `network-online.target`, `mariadb.service` e `mosquitto.service`, hanno `Restart=always` con `RestartSec=5` e sono abilitate all'avvio (`WantedBy=multi-user.target`);
5. esegue `daemon-reload`, `enable` e `restart` delle tre unità e ne mostra lo stato.

Lo script è **idempotente**: può essere rieseguito in qualsiasi momento (ad esempio dopo un aggiornamento) per rigenerare le unità e riavviare i servizi.

### Porte seriali fisse (opzionale)

Per default le unità usano `auto`. Per indicare una porta preferita:

```bash
LABSENS_PORT=/dev/serial/by-id/usb-FTDI_LC231X_FT603S4Q-if00-port0 \
BATTERY_PORT=/dev/serial/by-id/usb-FTDI_LC231X_FT603T6A-if00-port0 \
./setup-systemd-services.sh
```

La porta indicata viene provata per prima, ma se il dispositivo non risponde l'autodetect cerca comunque sulle altre porte.

> La variabile impostata nell'unità systemd (`Environment=…`) ha la **precedenza** su quella eventualmente presente in `.env`, perché `node --env-file` non sovrascrive le variabili già presenti nell'ambiente. Per cambiare la porta dei servizi systemd occorre quindi rieseguire lo script (o modificare l'unità), non basta modificare `.env`.

### Gestione dei servizi

```bash
# stato
systemctl status raspi-labsens raspi-battery raspi-battery-cmd-bridge

# avvio / arresto / riavvio
sudo systemctl restart raspi-labsens
sudo systemctl stop raspi-battery

# disabilitare l'avvio automatico
sudo systemctl disable raspi-battery-cmd-bridge

# log in tempo reale
journalctl -u raspi-labsens -f
journalctl -u raspi-battery -f
journalctl -u raspi-battery-cmd-bridge -f

# log dall'ultimo avvio del sistema
journalctl -u raspi-battery -b
```

Dopo aver modificato `.env` è sufficiente riavviare il servizio interessato.

### Disinstallazione dei servizi

```bash
sudo systemctl disable --now raspi-labsens raspi-battery raspi-battery-cmd-bridge
sudo rm /etc/systemd/system/raspi-{labsens,battery,battery-cmd-bridge}.service
sudo systemctl daemon-reload
```

## Esecuzione manuale

Utile per sviluppo e diagnosi. **Fermare prima il servizio systemd corrispondente**, altrimenti la porta seriale risulta occupata:

```bash
sudo systemctl stop raspi-labsens
npm start                     # = node --env-file=.env labsens-mqtt.js
```

| Comando npm | Script eseguito |
|---|---|
| `npm start` | `labsens-mqtt.js` |
| `npm run battery` | `battery-mqtt.js` |
| `npm run battery-cmd-bridge` | `battery-cmd-bridge.js` |
| `npm run dashboard` | `dashboard.js` |
| `npm run battery-remote` | `battery-remote-dashboard.js` |

Le variabili possono essere sovrascritte al volo dalla riga di comando:

```bash
LABSENS_POLL_INTERVAL=5000 npm start
```

Per terminare: `Ctrl+C` (arresto ordinato).

## Installazione delle dashboard su un PC remoto

Le dashboard richiedono solo l'accesso al broker MQTT.

```bash
git clone git@github.com:mceserani/Raspi-MQTT.git
cd Raspi-MQTT
npm install
cat > .env <<'EOF'
MQTT_BROKER=mqtt://<indirizzo-del-raspberry>:1883
MQTT_USERNAME=utente_mqtt
MQTT_PASSWORD=password_mqtt
EOF
npm run dashboard
npm run battery-remote
```

Su Windows/macOS serve Node.js ≥ 20.6. Non è necessario configurare MariaDB né le porte seriali. Verificare che la porta 1883 del Raspberry sia raggiungibile (firewall) e che Mosquitto ascolti sull'interfaccia di rete.

## Aggiornamento

```bash
cd ~/Raspi-MQTT
git pull
./setup-systemd-services.sh    # reinstalla le dipendenze e riavvia i servizi
```

Le tabelle esistenti non vengono modificate: `CREATE TABLE IF NOT EXISTS` non altera lo schema di una tabella già presente. Se una nuova versione aggiunge colonne, lo schema va aggiornato manualmente con `ALTER TABLE`.
