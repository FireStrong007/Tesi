# VitaBridge

Web app responsive (TypeScript + React + shadcn/ui) che sostituisce **Gadgetbridge** per i bracciali Garmin,
pensata per il **vívosmart 5**. Parla direttamente con il bracciale via **Web Bluetooth** e salva tutto in un
database **SQLite sul dispositivo** (OPFS del browser): nessun server, nessun cloud, nessun account.

## Avvio

```bash
npm install
npm run dev        # http://localhost:5173 (per il telefono: http://<ip-del-pc>:5173 non basta, vedi sotto)
npm run build      # build statica in dist/
npm test           # test del protocollo, del lettore FIT e della sincronizzazione end-to-end
```

Web Bluetooth funziona solo in un **contesto sicuro** (HTTPS o `localhost`). Per usarla sul telefono Android:

- **GitHub Pages (consigliato, gratis):** carica il progetto in un repository GitHub, poi *Settings → Pages → Source: GitHub Actions*.
  A ogni push su `main` il workflow `.github/workflows/pages.yml` compila e pubblica l'app su `https://<utente>.github.io/<repository>/`.
  Il sito contiene solo il codice: i dati restano nel database SQLite del telefono.
- in alternativa pubblica `dist/` su un altro hosting statico con HTTPS (Netlify, Cloudflare Pages…), oppure
- in sviluppo collega il telefono via USB e usa `chrome://inspect` → *Port forwarding* `5173 → localhost:5173`, poi apri `http://localhost:5173` sul telefono.

Poi da Chrome: menu ⋮ → **Installa app** (è una PWA, funziona anche offline).

**Browser supportati:** Chrome/Edge su Android, Windows, macOS, Linux, ChromeOS. Non funziona su Safari (iPhone) né Firefox.
**Consigliato:** telefono Android con Chrome per sincronizzare (il bracciale è sempre vicino); PC per consultare i grafici,
spostando i dati con *Impostazioni → Esporta/Importa database*.

## Primo collegamento del vívosmart 5

1. Togli il bracciale da Garmin Connect e dalle impostazioni Bluetooth del telefono (due app insieme vanno in conflitto, come con Gadgetbridge).
2. Metti il bracciale in modalità abbinamento.
3. *Dispositivi → Aggiungi → Cerca* e scegli «vívosmart 5»; se compare un codice, confermalo.
4. La prima sincronizzazione parte da sola. Se qualcosa non va: pagina **Log** → scarica il log.

Senza bracciale puoi usare **Prova la demo**: un vívosmart 5 simulato che parla lo stesso protocollo del vero
(stessi messaggi GFDI, stessi file FIT), quindi la demo attraversa esattamente lo stesso codice dei dati reali.

## Cosa replica di Gadgetbridge

| Gadgetbridge | VitaBridge |
|---|---|
| Elenco dispositivi con stato, batteria, pulsanti (connetti, sincronizza, grafici, trova, impostazioni) | ✅ |
| Dashboard con anello 24 h e riquadri (passi, sonno, battito, stress, Body Battery, SpO₂, HRV, respirazione, intensità) | ✅ |
| Grafici «Attività e sonno», Passi, **Calorie**, Sonno, Battito, Stress, Body Battery, SpO₂, Respirazione, HRV, Minuti di intensità – giorno/settimana/mese | ✅ |
| Per ogni metrica: anello/indicatore di riepilogo, riquadri per categoria, passi mancanti, debito di sonno, calorie attive + a riposo, Body Battery acquisita/persa | ✅ |
| Sonno con battito, ossigenazione o respirazione sovrapposti alle fasi; battito min/max/medio e momenti di irrequietezza | ✅ |
| Navigazione per giorno / settimana / mese e calendario | ✅ |
| Attività sportive con dettaglio (durata, distanza, passo, battito, percorso GPS, altitudine) | ✅ |
| Home in tempo reale: battito, passi, Body Battery, respirazione, piani (SpO₂ opzionale) dai canali live del bracciale | ✅ |
| Sincronizzazione automatica ogni 5–60 min mentre l'app è aperta, e al ritorno nell'app | ✅ |
| Trova bracciale, imposta ora, «trova telefono» dal bracciale | ✅ |
| Mantieni dati sul bracciale, rielabora file, importa .FIT, esporta/importa database | ✅ |
| Profilo utente e obiettivi, tema chiaro/scuro | ✅ |
| Inoltro notifiche/chiamate del telefono, controllo musica, sincronizzazione in background | ❌ impossibile da un browser |
| Meteo sul bracciale, invio allenamenti/percorsi, app Connect IQ | ⏳ non ancora |

## Architettura

```
src/lib/garmin/     protocollo Garmin (porting da Gadgetbridge)
  transport.ts        Web Bluetooth: servizio Multi-Link 6a4e2800-…, caratteristiche 2810/2820…
  multilink.ts        registrazione servizi su handle 0, canale GFDI, battito in tempo reale
  cobs.ts, crc.ts     framing COBS e CRC Garmin
  gfdi.ts             messaggi GFDI (device info, configurazione, ora, download, archivio, protobuf…)
  session.ts          handshake + sincronizzazione file (directory → download → archivia)
  protobuf.ts         mini codec protobuf per batteria e «trova bracciale»
src/lib/fit/        lettore/scrittore FIT; profile.ts generato dal fit_profile.json di Gadgetbridge
src/lib/db/         SQLite WASM in un worker (OPFS), schema, importer FIT → tabelle, query
src/lib/demo/       bracciale simulato + generatore di file FIT realistici
src/lib/device-manager.ts   collega sessioni BLE e database
src/components/ui/  componenti shadcn/ui (new-york, Radix)
src/components/charts/  grafici SVG nello stile di Gadgetbridge
src/pages/          Home, Dispositivi, Grafici, Attività, Impostazioni, Log
tests/              test (vitest)
```

### Database

Un file SQLite (`/vitabridge.sqlite3` nell'OPFS). Tabelle principali, tutte con `user_id` (paziente) e `device_id`,
timestamp in secondi Unix:

`user`, `device`, `fit_file` (file grezzi, per poterli rielaborare), `activity_sample` (un campione al minuto, passi già
convertiti da cumulativi a delta), `stress_sample`, `body_energy_sample`, `spo2_sample`, `respiratory_rate_sample`,
`resting_hr_sample`, `sleep_stage_sample`, `sleep_stats_sample`, `hrv_summary_sample`, `hrv_value_sample`,
`intensity_minutes_sample`, `workout`, `workout_record`. Schema completo in `src/lib/db/schema.ts`.

Tutte le query passano da `SqlExecutor` (`src/lib/db/sql.ts`): per la futura **area medici** basterà aprire in sola
lettura il database multi-paziente con lo stesso schema (o un adattatore) e scegliere il `user_id`.

## Come funziona la sincronizzazione

1. L'app chiede al bracciale l'elenco dei suoi file (la «directory»).
2. Scarica i file FIT di dati (monitoraggio giornaliero, sonno, HRV, attività…) che non ha già.
3. Li salva così come sono nella tabella `fit_file` e, finito il download, li importa nelle tabelle dei grafici in ordine cronologico.
4. Marca i file come archiviati sul bracciale (come Gadgetbridge), così la volta dopo non vengono riproposti.

Per questo, subito dopo una sincronizzazione, la successiva trova spesso **0 file**: è normale. Il bracciale scrive
nuovi file man mano che registra; nel frattempo i dati di oggi arrivano dai canali live (vedi sotto). Se anche la
**prima** sincronizzazione trova 0 file, guarda *Log → Diagnostica*: mostra cosa ha elencato il bracciale
e permette di scaricare un report da inviare.

## Importare i dati da Gadgetbridge

Si può usare Gadgetbridge durante la giornata e portare i dati qui quando si vuole:

1. In Gadgetbridge: impostazioni → gestione/backup dei dati → esporta lo **zip**. Contiene il suo database e la
   cartella `files/<MAC del bracciale>/…` con tutti i file `.fit` scaricati dal Garmin, identici a quelli che il
   bracciale manda a questa app.
2. Qui: *Impostazioni → Importa da Gadgetbridge* e scegli lo zip (vanno bene anche singoli `.fit`).

Come funziona (`src/lib/zip.ts`, `src/lib/gb-import.ts`):

- lo zip viene letto a pezzi nel browser (anche esportazioni grandi), senza caricarlo tutto in memoria;
- ogni file viene associato al bracciale tramite il **numero di serie** scritto nel file (lo stesso che il bracciale
  comunica quando si collega); i file non riconosciuti vanno al dispositivo scelto, o a uno nuovo;
- ogni file ha un'impronta **SHA-256**: se lo stesso file arriva due volte (zip importato di nuovo, oppure scaricato
  anche dal bracciale) viene saltato, quindi nessun dato è contato due volte;
- i file vengono elaborati in ordine di data; se sono più vecchi di dati già importati, i dati di quel dispositivo
  vengono ricostruiti da tutti i suoi file, così i totali giornalieri restano giusti in qualsiasi ordine arrivino.

Mentre Gadgetbridge è collegato al bracciale, questa app non può collegarsi (un bracciale, una connessione):
i dati in tempo reale funzionano solo quando è la web app a essere collegata.

## Calcoli allineati a Gadgetbridge

Verificati con un'esportazione reale di un vívosmart 5 confrontata con le schermate di Gadgetbridge (`src/lib/metrics.ts`, `src/lib/db/repo.ts`):

- **Sonno**: ogni fase scritta dal bracciale è il *limite finale* del periodo (dall'evento precedente o dall'inizio del
  sonno fino a quell'istante), come in `GarminSleepSessionProvider`. Inizio e fine della notte vengono dagli eventi 74.
- **Stress**: fasce dei Garmin 1–25 rilassato, 26–50 leggero, 51–75 moderato, 76–100 elevato; 0 = non misurato; ogni
  misura vale un intervallo di campionamento (1 minuto sul vívosmart 5).
- **Calorie**: attive dai file di monitoraggio; a riposo = metabolismo basale inviato dal bracciale, proporzionato alla
  parte di giornata trascorsa (se manca, stimato dal profilo con Mifflin-St Jeor).

Sul computer il riepilogo sta accanto ai grafici; sul telefono si impila come nell'app.

## Dati in tempo reale

Appena il bracciale si collega, l'app apre i suoi canali live (Multi-Link: battito 6, passi 7, piani 9, Body Battery 20,
respirazione 21; SpO₂ 19 solo se attivato) e la Home mostra i valori aggiornati ogni secondo circa. Ogni minuto i valori
live vengono salvati nella tabella `live_sample`; Home e grafici li accodano ai dati sincronizzati, quindi si aggiornano da
soli. Quando i file FIT coprono quel periodo, le righe live vengono ignorate (nessun doppio conteggio). Il totale passi
della Home è il contatore del bracciale; i grafici sommano i passi sincronizzati più quelli misurati dal vivo, e si
riallineano alla sincronizzazione successiva. Lo storico completo (sonno, stress, HRV…)
arriva con la sincronizzazione dei file, automatica ogni 15 minuti per impostazione predefinita.

Limiti: funziona solo con l'app aperta e il bracciale connesso (un browser non può restare collegato in background);
stress e calorie hanno un canale live il cui formato non è ancora decodificato, quindi si aggiornano con la sincronizzazione;
i canali live consumano un po' più batteria (SpO₂ molto di più, per questo è disattivato). Si regola in *Dispositivi → Opzioni*.

## Stato e limiti noti

- Il protocollo è un porting fedele di Gadgetbridge ed è verificato contro il bracciale simulato; **non è ancora stato
  provato con un vívosmart 5 reale**. Se il primo collegamento fallisce, il log mostra ogni pacchetto.
- Usa la modalità Multi-Link «semplice» (Gadgetbridge di default usa anche la variante affidabile MLR): se il bracciale la
  richiede comparirà un avviso nel log.
- Web Bluetooth non permette di scegliere l'MTU: le scritture usano pacchetti da 20 byte (modificabile nelle opzioni).

## Licenza

AGPL-3.0-or-later (contiene codice derivato da Gadgetbridge). Vedi `LICENSE`.
Non è un dispositivo medico: i valori sono indicativi.
