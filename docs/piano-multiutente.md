# Piano di lavoro: VitaBridge e HeartBridge multiutente

Questo documento è il riferimento per tutto il lavoro. Leggilo per intero prima di iniziare e rileggilo all'inizio di ogni fase.

## Contesto

Il progetto attuale (VitaBridge) è una web app React + TypeScript + shadcn che si collega via Web Bluetooth a un Garmin vívosmart 5, decodifica i file FIT e salva i dati in SQLite (WASM, OPFS) nel browser. I calcoli (sonno, stress, Body Battery, calorie) replicano quelli di Gadgetbridge.

I requisiti sono cambiati:

- **Le web app non si collegano più ai bracciali.** Leggono soltanto i dati già presenti su due server esistenti. I dati arrivano sui server dai telefoni dei partecipanti, tramite app Android di terzi: non è compito nostro.
- **Le app diventano due:**
  - **VitaBridge**: dati dei bracciali Garmin. Database con tabelle in formato Gadgetbridge.
  - **HeartBridge**: dati degli smartwatch Gima (Sportpix). Database diverso, con in più **ECG** e **pressione sanguigna**. Sarà usata da donne in gravidanza e persone con insufficienza cardiaca.
  - Per il resto sono la stessa app: **un unico progetto con due configurazioni**, non due copie del codice.
- **Ruoli: `partecipante` e `amministratore`.** Un partecipante fa il login e vede **solo i propri dati**. L'amministratore crea le credenziali dei partecipanti.
- **Il server esistente non va toccato in alcun modo**: niente modifiche al codice, allo schema o ai dati. Scriviamo un nostro server che legge i database **in sola lettura**.
- **Aggiornamento dei dati:** automatico circa ogni ora, più un pulsante "Sincronizza" che scarica subito i dati nuovi. Il pulsante legge dal server: non contatta i telefoni né i bracciali.
- **Confronto con la media degli altri:** nei grafici mensili c'è un pulsante "Confronta" che sovrappone la media giornaliera degli **altri partecipanti dello stesso server**. Non esiste un campo che indichi il gruppo di appartenenza (gravidanza o insufficienza cardiaca), quindi il confronto è su tutti.
- Lo schema dei database dei server è da considerare **definitivo** (`PRAGMA user_version = 1`).
- Tutta l'interfaccia è in **italiano**. I giorni si calcolano nel fuso **Europe/Rome**; i tempi nei database sono UTC.

## Dati di sviluppo

Ho due copie reali dei database dei server, che metterò in `data/`:

- `data/gadgetbridge.db`: server Garmin. Un solo database con **tutti** i partecipanti (oggi 7, con nomi in codice) e i loro dispositivi.
- `data/GimaDB.db`: server Gima. Oggi 1 partecipante di prova e 10 ECG.

Regole per questi file:

- Contengono dati di persone, hash di chiavi e token dei telefoni: **non vanno mai in git**. Aggiungi `data/` e `*.db` a `.gitignore` prima di qualsiasi commit e verifica che nessun `.db` sia tracciato.
- Si aprono **sempre in sola lettura**: driver read-only, `?mode=ro` e `PRAGMA query_only = ON`.
- Per test e CI crea invece un **generatore di database sintetici** con lo stesso schema. Prendi lo schema dalle tabelle dei file reali (`sqlite_master`). Genera più partecipanti finti, con dati realistici e alcune sezioni volutamente vuote.

### Formato dei dati Garmin (verificato sui dati reali)

Le tabelle sono quelle di Gadgetbridge: `GARMIN_ACTIVITY_SAMPLE`, `GARMIN_STRESS_SAMPLE`, `GARMIN_BODY_ENERGY_SAMPLE`, `GARMIN_SLEEP_STAGE_SAMPLE`, `GARMIN_SLEEP_STATS_SAMPLE`, `GARMIN_EVENT_SAMPLE`, `GARMIN_HEART_RATE_RESTING_SAMPLE`, `GARMIN_RESPIRATORY_RATE_SAMPLE`, `GARMIN_RESTING_METABOLIC_RATE_SAMPLE`, `GARMIN_SPO2_SAMPLE`, `GARMIN_HRV_*`, `GARMIN_INTENSITY_MINUTES_SAMPLE`, `GARMIN_NAP_SAMPLE`, `BATTERY_LEVEL`, `BASE_ACTIVITY_SUMMARY`. Poi `participant`, `device`, `collection_request`, `upload_batch`.

- `USER_ID` corrisponde a `participant.id`; `DEVICE_ID` corrisponde a `device.id`. Un partecipante può avere più dispositivi.
- **Unità di tempo miste:**
  - `GARMIN_ACTIVITY_SAMPLE.TIMESTAMP` e `BATTERY_LEVEL.TIMESTAMP` sono in **secondi**;
  - tutte le altre tabelle Garmin, `BASE_ACTIVITY_SUMMARY` e gli eventi sono in **millisecondi**.
- `GARMIN_ACTIVITY_SAMPLE` ha una riga al minuto:
  - `STEPS`, `DISTANCE_CM` e `ACTIVE_CALORIES` sono **contatori progressivi** per tipo di attività (`RAW_KIND`), non valori del singolo minuto;
  - `-1` significa "nessun dato", e vale anche per `HEART_RATE` e `RAW_INTENSITY`.

  Ricava i valori per minuto e per giorno **con la stessa logica di Gadgetbridge**: è nel sorgente di Gadgetbridge, cerca `GarminActivitySampleProvider` e le classi collegate.
- Sonno:
  - fasi in `GARMIN_SLEEP_STAGE_SAMPLE`;
  - inizio e fine notte in `GARMIN_EVENT_SAMPLE` con `EVENT = 74` (`EVENT_TYPE` 0 = inizio, 1 = fine);
  - punteggio in `GARMIN_SLEEP_STATS_SAMPLE`.

  Ogni campione di fase è il **limite superiore** di un tratto (logica di `GarminSleepSessionProvider`): l'app attuale lo gestisce già, riusa quella logica. Controlla nel sorgente di Gadgetbridge la codifica di `STAGE`.
- Stress: soglie Garmin 1–25 / 26–50 / 51–75 / 76–100; valori sotto 1 = non misurato. È già in `src/lib/metrics.ts`.
- **I dati sono disomogenei:** il sonno c'è solo per 2 partecipanti su 7, la SpO2 per 1, HRV e allenamenti per nessuno. Ogni sezione deve avere uno stato vuoto chiaro, per esempio "Il tuo bracciale non ha ancora registrato dati sul sonno".

### Formato dei dati Gima (verificato sui dati reali)

Tabelle: `ECG_MEASUREMENTS`, `GIMA_ACTIVITY_SAMPLE`, `GIMA_HEART_RATE_SAMPLE`, `GIMA_BLOOD_PRESSURE_SAMPLE`, `GIMA_SLEEP_STATS_SAMPLE`, `GIMA_SLEEP_STAGE_SAMPLE`, `GIMA_SPO2_SAMPLE`, `GIMA_RESPIRATORY_RATE_SAMPLE`, `GIMA_BODY_TEMPERATURE_SAMPLE`, `GIMA_HRV_VALUE_SAMPLE`. Poi `participant`, `device` (colonne diverse da Garmin: `hardware_id`, `firmware_version`, niente `manufacturer`/`type`), `collection_request`, `upload_batch`.

- **Tutti i tempi sono in millisecondi UTC.**
- `GIMA_ACTIVITY_SAMPLE`: blocchi di 30 minuti (`TIMESTAMP`–`TIMESTAMP_END`). I passi sono **del singolo blocco**, non progressivi.
- `GIMA_SLEEP_STAGE_SAMPLE`: inizio, `DURATION_SEC`, `STAGE`. Ho verificato sui totali di `GIMA_SLEEP_STATS_SAMPLE` che **241 = sonno profondo** e **242 = sonno leggero**. Tratta qualsiasi altro codice come "sconosciuto", senza farlo fallire.
- `GIMA_BLOOD_PRESSURE_SAMPLE`: sistolica e diastolica.
- Valori non validi presenti nei dati veri: temperatura 0,15 °C (accetta solo 30–43 °C), 0 come "non misurato" in battito, pressione, HRV e durata. Filtrali in un unico punto del codice, non sparsi nei grafici.
- `ECG_MEASUREMENTS`, una riga per registrazione (chiave `start_measure_ms`):
  - `duration_ms`, `sample_count`, `heart`, `sbp`, `dbp`, `hrv`, `is_afib`, `diagnose_type`, `ai_heart`;
  - `ecg_data`: BLOB di interi **32 bit little-endian con segno**. Nei dati veri ci sono circa 5.080 campioni, con valori tra −500 e +500.

  Due cose **non sono note**:
  - la **frequenza di campionamento**: il codice dell'app Gima indica 250 Hz, ma `duration_ms` (quando c'è, circa 68 s) indica circa 75 Hz;
  - l'**unità** dei campioni.

  Rendile **costanti configurabili** in un solo file, con un commento `TODO: da confermare con il gestore del server`, e mostrale in fondo al visualizzatore ECG.
- `diagnose_type` e `is_afib` sono calcolati dal software del produttore. Mostrali **così come sono**, con etichette prudenti:
  - `is_afib = 1`: "Possibile fibrillazione atriale (secondo il dispositivo)";
  - `diagnose_type` 1: "Ritmo normale (secondo il dispositivo)";
  - 5: "Possibili battiti prematuri ventricolari";
  - 9: "Possibili battiti prematuri atriali";
  - altri valori: "Non classificato".

  Aggiungi sempre la nota "Valutazione automatica del dispositivo, non è una diagnosi medica". `ai_heart` sopra 300 è da considerare non valido. L'app **non calcola** diagnosi proprie.

## Architettura richiesta

1. **Un unico repository con workspace npm:**
   - `packages/core`: tutto ciò che è indipendente da browser e server. Calcoli (`metrics.ts`, logica di `day-data.ts`/`range-data.ts`), conversione dai formati dei database ai dati dell'app (adattatori Garmin e Gima), formati numerici e date, tipi condivisi.
   - `packages/server`: server Node in TypeScript, con Hono o Fastify.
   - `apps/web`: l'app React. Il marchio si sceglie in fase di build (`VITE_APP=vitabridge|heartbridge`): nome, colori, icona, metriche disponibili, sezioni ECG e pressione.

   Server e browser usano **le stesse funzioni di core**, così i numeri dell'app, delle medie e dei test coincidono.
2. **Lettura dei dati dal server esistente, senza toccarlo.** Crea un'interfaccia `DataSource` con due modalità:
   - `file`: apre in sola lettura un percorso locale. Si usa per lo sviluppo con `data/*.db`.
   - `backup`: ogni N minuti (default 60, configurabile) scarica una copia coerente del database dall'endpoint `GET /admin/backup` del server esistente (HTTP Basic con credenziali di amministratore da variabili d'ambiente). Poi:
     - la verifica con `PRAGMA quick_check` e controlla `user_version = 1` e la presenza delle tabelle attese;
     - la sostituisce in modo atomico;
     - tiene l'ultima copia valida se il download fallisce.

     È la modalità preferita in produzione: un database SQLite in WAL scritto da un altro processo non si apre in modo affidabile da una cartella montata in sola lettura.

   Scrivi questa motivazione nel README.
3. **Ogni app ha il suo server e il suo database di autenticazione**, separato da quello dei dati: SQLite scritto dal nostro server, per esempio `auth/vitabridge-auth.db`. Contiene la tabella `account`:
   - `id`, `username` (unico), `password_hash`, `role` (`participant` o `admin`), `participant_id` (riferimento a `participant.id` del database dati; null per gli admin);
   - `must_change_password`, `disabled`, `created_at`, `last_login_at`.
4. **Sicurezza:**
   - password con `scrypt` di `node:crypto` (o argon2id), mai in chiaro;
   - sessione in cookie `HttpOnly`, `Secure` in produzione, `SameSite=Strict`, con scadenza;
   - token CSRF per le richieste che modificano dati;
   - limite ai tentativi di login;
   - il server ricava `participant_id` **solo dalla sessione**: nessun endpoint accetta un id di partecipante dal client;
   - un partecipante non deve mai poter ottenere righe di altri, neanche per errore. Scrivi test che lo dimostrino.
5. **Amministrazione:**
   - il primo amministratore si crea all'avvio da variabili d'ambiente (`ADMIN_USERNAME`, `ADMIN_PASSWORD`);
   - pagina admin con l'elenco dei partecipanti del database dati (codice, dispositivi, ultima misura, ultimo caricamento, ha già un account o no);
   - creazione di un account per un partecipante, con password temporanea **mostrata una sola volta** e cambio obbligatorio al primo accesso;
   - reimpostazione della password e disattivazione dell'account;
   - l'amministratore **non** vede i dati sanitari dei partecipanti.
6. **Sincronizzazione nel browser:**
   - la web app tiene una **copia locale dei soli dati della persona collegata** nel SQLite WASM/OPFS esistente;
   - al primo accesso scarica tutto; poi, per ogni tabella, riscarica gli ultimi 3 giorni più tutto ciò che è più recente, e aggiorna in base alla chiave primaria. I dati sul server possono arrivare in ritardo o essere sostituiti, e non c'è una colonna "modificato il";
   - la sincronizzazione parte all'apertura, ogni ora mentre l'app è aperta e con il pulsante "Sincronizza";
   - mostra "Ultimo aggiornamento: …" e, per ogni dispositivo, l'ora dell'ultimo caricamento dal telefono (`device.last_successful_upload_at`), così l'utente capisce se i dati mancano perché il telefono non li ha ancora inviati;
   - **al logout la copia locale si cancella**, così come quando cambia l'utente collegato.
7. **Confronto con gli altri (server):**
   - il server calcola i riepiloghi giornalieri di ogni partecipante con le funzioni di core e li tiene in cache, ricalcolandoli quando cambia la copia del database;
   - endpoint per media e numero di partecipanti per giorno e per metrica, **escludendo il richiedente**;
   - se i partecipanti validi in un giorno sono meno di 5, la media è null e l'interfaccia mostra "Non ci sono abbastanza partecipanti per un confronto". Per esempio HeartBridge oggi ha 1 partecipante;
   - un giorno di un partecipante conta solo se ha dati sufficienti per quella metrica. Per le metriche giornaliere basate sull'attività, per esempio, almeno 12 ore con battito registrato (soglia configurabile);
   - se nel progetto esiste già il pulsante "Confronta" con una sorgente demo (`src/lib/comparison/`), sostituisci la sorgente con quella del server mantenendo l'interfaccia. Se non esiste, implementalo come descritto in "Contesto": linea o punti nel colore `--compare`, legenda "Tu" / "Media altri partecipanti (n = …)", tooltip con entrambi i valori, stato salvato nell'URL.
8. **Cosa togliere dall'interfaccia:** collegamento Bluetooth, dati in tempo reale, sincronizzazione automatica col bracciale, importazione di FIT e zip di Gadgetbridge, simulatore del bracciale e modalità demo. La pagina "Dispositivi" diventa informativa: modello, batteria (da `BATTERY_LEVEL` per Garmin), ultima misura, ultimo caricamento. **Tutto il vecchio codice resta nel ramo git `legacy-bluetooth`** (vedi Fase 0). Su `main` puoi eliminarlo.
9. **Pubblicazione:**
   - il server Node serve anche i file della web app compilata, **stesso dominio**, così i cookie funzionano senza CORS;
   - disattiva il workflow di GitHub Pages (`.github/workflows/pages.yml`), che non può ospitare un server;
   - aggiungi `Dockerfile` e `compose.yaml` con due servizi, `vitabridge` e `heartbridge`, ognuno con le sue variabili d'ambiente e i suoi volumi.

## HeartBridge: funzionalità in più

- **Home:** sezione **ECG** con l'ultima registrazione: data e ora, battito, pressione e HRV della misura, valutazione del dispositivo e un'anteprima del tracciato. Poi la sezione **Pressione** con l'ultima misura e la media degli ultimi 7 giorni.
- **Pagina ECG:**
  - elenco delle registrazioni, con filtro per mese;
  - visualizzatore del tracciato su griglia ECG standard (25 mm/s; quadretti piccoli 0,04 s e grandi 0,2 s), disegnato su `<canvas>` per fluidità;
  - zoom e scorrimento orizzontale, utilizzabile al tocco su telefono;
  - valori della misura, valutazione con la nota "non è una diagnosi" e i parametri usati (frequenza e unità configurabili).
- **Grafici della pressione:**
  - vista giorno con sistolica e diastolica per misura;
  - viste settimana e mese con media giornaliera e intervallo minimo–massimo;
  - nessuna classificazione clinica automatica.
- Le altre metriche Gima (battito, SpO2, temperatura, HRV/CVRR, respirazione, passi a blocchi di 30 minuti, sonno) usano gli stessi grafici di VitaBridge, attraverso l'adattatore Gima di core.
- Il pulsante "Confronta" vale anche per HeartBridge, sui partecipanti del server Gima.

## Verifica dei calcoli (obbligatoria)

Ho un export di Gadgetbridge del mio bracciale, `gadgetbridge_20261106122516.zip`, che ti darò. Contiene **sia i file FIT sia il database di Gadgetbridge** ricavato da quei file, nello stesso formato delle tabelle del server Garmin. I miei dati sono quelli con `DEVICE_ID = 4`, dal 3 novembre 2026 alle 18:02 in poi.

- Calcola i valori giornalieri con il codice del ramo `legacy-bluetooth`, partendo dai FIT. Poi calcolali con il nuovo adattatore Garmin di core, partendo dal database di Gadgetbridge. I risultati devono coincidere: passi, distanza, calorie attive, battito a riposo, minuti per livello di stress, Body Battery caricato e consumato, durata del sonno per fase, per le notti e i giorni completi presenti in entrambi.
- Valori già noti: passi **2.594** il 4/11, **4.450** il 5/11, **704** il 6/11 (fino alle 12:25 circa).
- Salva i valori attesi come fixture. Non mettere nei test il database personale: estrai solo le righe necessarie e i numeri attesi.

## Modo di lavorare

- Lavora **una fase alla volta**. All'inizio di ogni fase proponimi un piano breve (file toccati, scelte tecniche) e **aspetta la mia conferma**. A fine fase:
  - esegui typecheck, test e build;
  - fai un commit con un messaggio chiaro;
  - riassumimi cosa è cambiato e cosa devo provare io.
- Se qualcosa in questo documento è in contraddizione con il codice o con i dati, fermati e chiedimi invece di indovinare.
- Non modificare mai i file in `data/` e non aprirli in scrittura.

### Fase 0: preparazione
1. Verifica lo stato di git. Crea il ramo **`legacy-bluetooth`** dallo stato attuale di `main` e, se esiste un remote, fai il push. Poi crea un ramo di lavoro `multiutente` da `main`.
2. Aggiungi `data/`, `*.db`, `auth/` e `.env` a `.gitignore`.
3. Leggi il codice esistente e i due database in sola lettura, poi presentami il piano dettagliato di tutte le fasi.

### Fase 1: riorganizzazione in workspace
Sposta il codice in `packages/core` e `apps/web` senza cambiare il comportamento. I test esistenti devono passare.

### Fase 2: server di lettura, login e amministrazione
`DataSource` (modalità `file` e `backup`), database di autenticazione, login e logout, cambio password, pagine e API di amministrazione, test di isolamento tra partecipanti, generatore di database sintetici.

### Fase 3: VitaBridge sui dati del server
Adattatore Garmin in core, sincronizzazione nel browser, rimozione delle parti Bluetooth dall'interfaccia, stati vuoti, pagina Dispositivi informativa, verifica dei calcoli con l'export.

### Fase 4: confronto con gli altri partecipanti
Riepiloghi giornalieri sul server, endpoint delle medie, pulsante "Confronta" collegato al server.

### Fase 5: HeartBridge
Configurazione del marchio, adattatore Gima, sezioni ECG e pressione nella Home, pagina ECG, grafici della pressione, confronto.

### Fase 6: pubblicazione e documentazione
`Dockerfile`, `compose.yaml`, disattivazione di GitHub Pages, README in italiano con:
- avvio in sviluppo (con `data/*.db`);
- variabili d'ambiente;
- modalità `backup` e sua motivazione;
- creazione del primo amministratore e degli account;
- verifica a 390 px (telefono) e su desktop di tutte le pagine di entrambe le app, in tema chiaro e scuro.
