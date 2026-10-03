# Piano: misura della CO2

> Documento di lavoro per riprendere il progetto in sessioni successive.
> Stato: **installato e verificato sul Pi (03/10)**; settimana di osservazione per tarare le soglie (§7).
> Ultimo aggiornamento: 2026-10-03

---

## 1. Obiettivo

Aggiungere la concentrazione di CO2 alle misure del laboratorio, con lo stesso trattamento delle altre grandezze: acquisizione, salvataggio, soglie ed eventi del supervisore, riassunti, report e interpretazione da parte dell'agente.

Fonti: `scuole_labs_docs/Registri schede.xlsx` (foglio LabSensors) e `scuole_labs_docs/Dispensa_Sensoristica_LabSensors.pdf` (pagine 29-34, 119-124). La cartella è locale e non versionata.

## 2. Il sensore

La scheda LabSensors (indirizzo Modbus 29, la stessa del SEN55) monta un **Sensirion SCD30**:

| Registro | Grandezza | Formato | Unità | Note dalla dispensa |
|---|---|---|---|---|
| 80 | Temperatura | Int16 ×100 | °C | ± (0,4 + 0,023 × (T − 25)) °C |
| 81 | Umidità relativa | Uint16 ×100 | % | ± 3 %, attivazione 8 s |
| 82 | CO2 | Uint16 ×1 | ppm | NDIR, 0-40.000 ppm, ± 30 ppm tra 400 e 10.000, attivazione 20 s |

Non serve hardware nuovo. La dispensa propone già due esperienze collegate: "Campionamento di CO₂" e "Indice qualità dell'aria".

## 3. Criticità da risolvere prima

### 3.1 Modifica del codice esistente

La CO2 è sulla stessa scheda e sulla stessa porta seriale che `labsens-mqtt.js` tiene aperta in esclusiva: un servizio separato non può leggerla. Serve una modifica circoscritta a `labsens-mqtt.js`, in deroga alla regola "servizi esistenti invariati" del [piano dell'agente](PIANO-AGENTE.md#3-decisioni-prese):

- lettura dei registri 80-82 in una richiesta separata (non allargare il blocco 64-69: i registri 70-79 potrebbero non esistere);
- argomenti MQTT `sensors/lab/co2`, `sensors/lab/scd30_temperature`, `sensors/lab/scd30_humidity` (senza retain, come gli altri);
- nuove colonne in `labsens_measurements`, aggiunte all'avvio se mancano (in MariaDB l'aggiunta di colonne in coda è immediata anche su tabelle grandi).

### 3.2 Scale del SEN55 (problema dei dati attuali)

Il foglio dei registri e la dispensa (pagina 33) concordano su scale diverse da quelle usate da `labsens-mqtt.js`, che divide per 100 tutti i registri 64-69:

| Grandezza | Formato sulla scheda | Oggi nel codice | Effetto sui dati salvati |
|---|---|---|---|
| Temperatura, umidità | ×100 | ÷100 | corretti |
| PM10, PM2.5 | ×10 (1 decimale) | ÷100 | 10 volte più bassi |
| VOC, NOx | indice 0-500 (×1) | ÷100, chiamato "ppb" | 100 volte più bassi, e sono indici, non ppb |

**Confermato sul Pi il 2026-10-03** (medie delle ultime 24 ore): PM2.5 0,80 (massimo 1,09), indice VOC 0,91, indice NOx 0,01. Con la scala corretta: 8,0 µg/m³ (massimo 10,9), 91 e 1, tutti plausibili.

Le soglie del supervisore sono già nelle unità corrette (PM2.5 warning 35 µg/m³, VOC 250, NOx 20) ma vengono confrontate con dati 10 o 100 volte troppo bassi: il monitoraggio di PM, VOC e NOx non è mai potuto scattare (per un avviso il PM2.5 reale avrebbe dovuto superare 350 µg/m³), e i report hanno sempre indicato valori sotto i riferimenti OMS. Con la correzione le soglie tornano attive subito: possono comparire i primi eventi veri. La correzione tocca lo stesso file della CO2: conviene farla nello stesso intervento, decidendo come trattare lo storico (§5).

## 4. Piano d'azione

| # | Passo | Contenuto | Complessità |
|---|---|---|---|
| 0 | Verifiche sul Pi | Query sulle scale del SEN55 (sotto, ✅ fatta: problema confermato); lettura una tantum dei registri 80-82 a servizio fermo: sensore presente, valori tra 400 e 1000 ppm, comportamento nei primi 20 s | Bassa |
| 1 | `labsens-mqtt.js` | Registri 80-82, argomenti MQTT, colonne, scarto di 0 e valori fuori intervallo durante il riscaldamento; eventuale correzione delle scale del SEN55 | Media: servizio in produzione |
| 2 | Supervisore | `co2` tra le grandezze del laboratorio: soglie, intervallo valido, dati fermi, salita rapida, riassunti al minuto e all'ora, `/status` | Bassa |
| 3 | Server MCP e report | Riferimenti per la CO2 al posto dei valori guida OMS, ore sopra 1000 ppm al giorno, ore di picco, confronto con il periodo precedente | Bassa-media |
| 4 | Istruzioni dell'agente | Interpretazione nel triage (CO2 alta di giorno = presenze e poca ventilazione, non un guasto, raramente un'indagine) e nei report | Bassa |
| 5 | Simulatore e test | Profilo con giorno e notte e presenze, casi di soglia e di riscaldamento, nuove colonne | Media |
| 6 | Documentazione | Registri, argomenti, colonne, soglie, guida d'uso | Bassa |
| 7 | Installazione e taratura | Installazione sul Pi in un momento tranquillo, una settimana di osservazione, ritocco di soglie e durate minime | Bassa, richiede tempo |

**Complessità complessiva: media.** Il lavoro sul PC è paragonabile alla fase 4a del piano dell'agente; il rischio sta nel passo 1 e nella decisione sullo storico del SEN55. Con la taratura: circa 7-10 giorni di calendario.

Query del passo 0:

```sql
SELECT ROUND(AVG(pm2_5),2) AS pm25_media, MAX(pm2_5) AS pm25_max,
       ROUND(AVG(voc),2) AS voc_media, ROUND(AVG(nox),2) AS nox_media
FROM labsens_measurements WHERE recorded_at >= NOW() - INTERVAL 1 DAY;
```

L'indice VOC del SEN55 si assesta intorno a 100 in aria normale e l'indice NOx intorno a 1: un VOC medio vicino a 1,0 e un PM2.5 di pochi decimi confermano il problema delle scale.

### Soglie di partenza

| Livello | CO2 | Significato |
|---|---|---|
| info | ≥ 1000 ppm per 10 min | aria da ricambiare (solo registrato, non arriva su Telegram) |
| warning | ≥ 1500 ppm per 10 min | ventilare |
| warning | ≥ 2000 ppm | calo di attenzione, mal di testa (tabella della dispensa) |
| critical | ≥ 5000 ppm | limite di esposizione lavorativa sulle 8 ore: anomalia seria o misura guasta |

Più le regole già usate per le altre grandezze: dati fermi, valori impossibili, salita rapida.

### Altre criticità

- **Calibrazione:** l'SCD30 si ricalibra da solo solo se vede regolarmente aria esterna (circa 420 ppm); in un laboratorio chiuso può derivare, e i registri della scheda non permettono di calibrarlo da software. Rimedio: verifica periodica a finestre aperte; l'agente può segnalare la deriva se il minimo notturno sale nel tempo.
- **Riscaldamento:** dopo un'accensione il primo valore valido arriva dopo circa 20 s; gli zeri vanno scartati.
- **Falsi allarmi e budget:** una persona che respira vicino al sensore alza la CO2 per qualche minuto; servono durata minima e isteresi, altrimenti il triage consuma esecuzioni.
- **Fermo dei dati:** il riavvio di `labsens-mqtt.js` interrompe brevemente le misure del laboratorio; si torna indietro con git.
- **Dashboard:** `dashboard.js` sul PC non mostra la CO2 senza una piccola modifica (facoltativa).
- **Doppioni:** temperatura e umidità di SCD30 e SEN55 vanno salvate senza soglie, per l'esperienza "Compatibilità fra misure" e come controllo incrociato.

## 5. Decisioni (03/10)

1. `labsens-mqtt.js` si modifica (deroga alla regola "codice esistente invariato", solo per questo servizio). Modificato anche `dashboard.js` sul PC (CO2, unità e scale di VOC e NOx).
2. Scale del SEN55 corrette nello stesso intervento; storico **ricalcolato** (`tools/migrate-sen55-scale.js`: righe grezze e riassunti, a blocchi, riprendibile, mai applicato due volte).
3. Solo la CO2 (registro 82); temperatura e umidità dell'SCD30 non si leggono.
4. Soglie del §4 confermate.

## 6. Cosa è stato fatto

- `labsens-mqtt.js`: scale e segni dal foglio dei registri, lettura del registro 82 (0 = nessuna misura → NULL, non pubblicato; una lettura fallita non ferma le altre grandezze), argomento `sensors/lab/co2`, colonna `co2` aggiunta all'avvio.
- Supervisore: grandezza `co2`; soglie con livello `info` e più gradini per livello, con notifica del gradino più alto della stessa gravità (🔺); `/status` mostra la CO2.
- Server MCP e report: `co2` tra le metriche, riferimento orario (ore con media sopra 1000 ppm), limite di righe della query oraria portato a 10 metriche; unità di VOC e NOx come indici.
- Agente: sezione "Qualità dell'aria" in `CLAUDE.md` (lettura della CO2, indici VOC e NOx, valori vecchi prima del 3 ottobre).
- Strumenti: `tools/read-labsens.js` (lettura una tantum dei registri), `tools/migrate-sen55-scale.js` (ricalcolo dello storico).
- Simulatore con le scale corrette e un profilo di CO2 giorno e notte; test (129 verdi); documentazione (riferimento, installazione, supervisore, utilizzo).

## 7. Verifica sul Pi (03/10) e prossimi passi

- `tools/read-labsens.js`: SCD30 presente, CO2 497 ppm, umidità SCD30 50,7 %.
- Migrazione: 314.522 righe grezze (id da 1 a 314.522), 24.760 riassunti al minuto e 416 orari (le 104 ore dall'installazione del supervisore). Dopo: PM2.5 medio 7,9 µg/m³, VOC 77, NOx 1, CO2 496 ppm; `/status` mostra la CO2.
- Continuità: l'indice VOC ricalcolato fino alle 16:08 (233) prosegue senza salti in quello letto dal servizio nuovo dalle 16:14 (235): il fattore ×100 è esatto.
- Primo fenomeno reso visibile dalla correzione: dalle 14:00 del 03/10, dopo una pulizia del locale, l'indice VOC è salito gradualmente da circa 90 a 235 (soglia di warning 250). Con la scala vecchia sarebbe risultato 2,35.

Da osservare nella prossima settimana: avvisi CO2 utili o inutili, minimo notturno (atteso 420-450 ppm; se cresce di giorno in giorno è deriva), primi avvisi di PM, VOC e NOx con le soglie finalmente attive. Poi taratura di soglie, durate minime e isteresi.
