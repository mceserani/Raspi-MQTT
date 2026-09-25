# Raspi-MQTT

Gateway **Modbus RTU → MQTT + MariaDB** per Raspberry Pi.

Il software interroga periodicamente due dispositivi collegati via RS-485 (adattatori USB-seriale):

| Dispositivo | Indirizzo Modbus (default) | Cosa fornisce |
|---|---|---|
| **Scheda sensori di laboratorio** ("labsens") | `29` | temperatura, umidità, PM10, PM2.5, VOC, NOx, temperatura NTC |
| **Controller di carica/scarica batteria** ("battery") | `4` | setpoint e misure di corrente/tensione, stato di marcia, tipo batteria |

Per ogni lettura i valori vengono:

1. **pubblicati su MQTT** (un topic per grandezza, payload JSON);
2. **salvati su MariaDB** (una riga per ciclo di polling).

Il controller batteria può anche essere **comandato da remoto** via MQTT (impostazione di corrente, tensione e stato di marcia, scrittura diretta di registri), con conferma di esito (ACK) su un topic dedicato.

Sono incluse due **dashboard da terminale** per consultare i dati in tempo reale e inviare comandi, utilizzabili anche da un PC remoto.

## Componenti

| File | Tipo | Ruolo |
|---|---|---|
| `labsens-mqtt.js` | servizio | polling della scheda sensori → MQTT + MariaDB |
| `battery-mqtt.js` | servizio | polling del controller batteria → MQTT + MariaDB, esecuzione dei comandi |
| `battery-cmd-bridge.js` | servizio | valida i comandi in arrivo e li inoltra a `battery-mqtt.js` |
| `modbus-autodetect.js` | libreria | individua automaticamente su quale porta seriale si trova ciascun dispositivo |
| `dashboard.js` | client interattivo | dashboard dei sensori di laboratorio |
| `battery-remote-dashboard.js` | client interattivo | dashboard della batteria con console comandi |
| `setup-systemd-services.sh` | script | installa e avvia i tre servizi come unità systemd |

## Avvio rapido

```bash
# 1. dipendenze
npm install

# 2. configurazione minima
cat > .env <<'EOF'
MQTT_BROKER=mqtt://localhost:1883
MQTT_USERNAME=utente_mqtt
MQTT_PASSWORD=password_mqtt
MARIADB_PASSWORD=password_db
EOF

# 3a. esecuzione manuale (un terminale per servizio)
npm start                    # sensori di laboratorio
npm run battery              # controller batteria
npm run battery-cmd-bridge   # bridge comandi

# 3b. oppure installazione come servizi di sistema
./setup-systemd-services.sh

# 4. consultazione
npm run dashboard            # dashboard sensori
npm run battery-remote       # dashboard + comandi batteria
```

## Documentazione

| Documento | Contenuto |
|---|---|
| [docs/architettura.md](docs/architettura.md) | Architettura, flussi dei dati, funzionamento interno di ogni componente |
| [docs/installazione.md](docs/installazione.md) | Prerequisiti, installazione, configurazione (`.env`), servizi systemd |
| [docs/utilizzo.md](docs/utilizzo.md) | Guida d'uso: dashboard, invio comandi, consultazione dei dati |
| [docs/riferimento.md](docs/riferimento.md) | Riferimento tecnico: topic e payload MQTT, registri Modbus, schema del database |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Diagnostica, messaggi di log, problemi noti e limitazioni |

## Requisiti in breve

- Raspberry Pi (o altro Linux) con **Node.js ≥ 20.6** (per `--env-file`)
- Broker **MQTT** (es. Mosquitto)
- **MariaDB** (o MySQL compatibile)
- Adattatori **USB ↔ RS-485** visibili in `/dev/serial/by-id/`

## Licenza

MIT — Matteo Ceserani
