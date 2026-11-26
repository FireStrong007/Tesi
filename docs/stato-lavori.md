# Stato dei lavori

Ultimo aggiornamento: 26 novembre 2026, ramo `multiutente`.

Il riferimento per il lavoro è `docs/piano-multiutente.md`. Questo file dice a che punto siamo.

## Rami

- **`main`:** lo stato di `formato-server` (portato avanti senza merge il 23 novembre).
- **`legacy-bluetooth`:** il vecchio codice con Bluetooth, demo e importazione dei FIT, da `main`. Non si tocca più.
- **`multiutente`:** il lavoro del nuovo piano. Viene inviato su GitHub a fine di ogni fase, dopo aver controllato che non ci siano `.db` né file di `data/`, `/auth/`, `/backup/` o `.env`.

## Fasi

| Fase | Stato |
|---|---|
| 0. Preparazione | fatta |
| 1. Workspace (`packages/core`, `apps/web`) | fatta |
| 2. Server di lettura, login, amministrazione | fatta, con i comandi per gli amministratori |
| 3. VitaBridge sui dati del server | fatta |
| 4. Confronto con gli altri partecipanti | fatta |
| 5. HeartBridge | fatta |
| 6. Pubblicazione e documentazione | **prossima** |

## Cosa c'è oggi

### Struttura
- **`packages/core`:** calcoli, formati, fuso, query sui dati, confronto, formato del server e catalogo delle due app (`datasets.ts`). Non può usare funzioni del browser né di Node.
- **`packages/server`:** server Node (Hono, `node:sqlite`, Node ≥ 24).
- **`packages/synth`:** codice FIT, generatore demo e generatore di database sintetici, solo per sviluppo e test.
- **`apps/web`:** la web app, senza Bluetooth, demo né importazione: legge solo i dati del server.

### Server
- **Lettura dei dati:** modalità `file` (sviluppo) o `backup` (copie da `GET /admin/backup` ogni 60 minuti, verificate e sostituite in modo atomico). Le copie si aprono sempre con `mode=ro&immutable=1`, `readOnly` e `PRAGMA query_only`.
- **«Sincronizza»:** scarica una copia nuova solo se quella in uso ha più di 5 minuti, con un solo scaricamento alla volta per tutti.
- **Account:** database separato (`auth/<app>-auth.db`) con account, sessioni e registro delle azioni (`audit_log`).
  - Password con `scrypt`; cookie `HttpOnly`/`SameSite=Strict`; CSRF; controllo di `Origin` (`PUBLIC_ORIGIN`).
  - Limite ai tentativi di accesso per nome utente e per IP (`TRUST_PROXY` per l'IP dietro un proxy).
  - Sessioni che scadono per inattività: 30 giorni per i partecipanti, 8 ore per gli amministratori.
- **Isolamento:** un solo modulo legge i dati sanitari, sempre del partecipante della sessione. L'amministratore vede solo codici, dispositivi e date.
- **Amministratori solo da riga di comando sul server**, mai dal web:
  - `npm run admin:create -- <nome>` crea un amministratore;
  - `npm run admin:reset-password -- <nome>` dà una nuova password temporanea a qualsiasi account (serve anche a recuperare un amministratore);
  - entrambi mostrano la password temporanea una sola volta, impongono il cambio al primo accesso e scrivono nel registro (autore `cli:<utente del sistema>`);
  - dopo la build: `node packages/server/dist/admin.js create|reset-password <nome>`.
- Il primo amministratore si crea anche da `ADMIN_USERNAME`/`ADMIN_PASSWORD` all'avvio.

### VitaBridge sui dati del server (Fase 3)
- **Copia locale:** i dati della persona collegata stanno nel browser (SQLite su OPFS), nelle stesse tabelle del server. Al logout la copia e la sua cartella OPFS vengono cancellate; se entra un'altra persona, la copia viene svuotata.
- **Sincronizzazione:** all'apertura, ogni ora e con «Sincronizza», per tabella e per dispositivo.
  - Si riscaricano gli ultimi 3 giorni di ogni dispositivo.
  - Poi si confrontano i conteggi con il server (`/api/data/counts`); se non coincidono, si riscarica tutto quel dispositivo per quella tabella.
- **Tabelle dell'app:** persistenti nella copia; dopo una sincronizzazione si ricostruiscono solo i giorni toccati, e all'avvio non si ricostruisce niente.
- **Fuso:** giorni e ore sempre in `Europe/Rome`, anche su un dispositivo in un altro fuso.
- **Giorno valido:** 12 ore con battito, configurabile con `VALID_DAY_MIN_HOURS`.
- **Obiettivi:** salvati sul server con l'account (`/api/me/settings`).
- **Pagine:**
  - Home con «Ultimo aggiornamento» e ultimo invio dal telefono;
  - stati vuoti per sezione («Il tuo bracciale non ha ancora registrato…»);
  - Dispositivi informativa (batteria, ultima misura, ultimo caricamento);
  - Impostazioni con account, obiettivi, tema e copia locale.
- **«Confronta»:** vedi la Fase 4.
- **Altro:**
  - senza connessione si vedono i dati già scaricati;
  - in http da un indirizzo di rete l'app chiede l'indirizzo https;
  - nel menu la voce attiva si distingue da quella sotto il mouse.

### Tempi misurati (partecipante 3 dei dati reali, 260.681 righe, 234.928 di attività)
| | PC, CPU normale | CPU 4× |
|---|---|---|
| Primo accesso: scaricamento | 3,6 s | 5,2 s |
| Primo accesso: costruzione delle tabelle | 2,2 s | 2,0 s* |
| Avvio con la copia già presente | nessuna ricostruzione | nessuna ricostruzione |
| «Sincronizza»: finestre + ricostruzione parziale | 0,4 + 0,3 s | 0,55 + 0,3 s* |

\* DevTools non può rallentare i worker («Operation is only supported for pages, not workers»): il rallentamento vale solo per la pagina, mentre la costruzione delle tabelle (nel worker) gira alla velocità del PC. Su un telefono 4–6 volte più lento la costruzione del primo accesso sarebbe di circa 9–13 s (una volta sola, con la barra di avanzamento) e quella dopo «Sincronizza» di 1–2 s, con i dati già sullo schermo. Per misurarlo su un telefono vero: Chrome per Android con il debug remoto, `performance.getEntriesByType("measure")` (voci `bridge:open`, `bridge:sync`, `bridge:rebuild`).

### Confronto con gli altri partecipanti (Fase 4)
- **Dove si calcola:** sul server, mai nel browser. Il server tiene in memoria una cache con i valori giornalieri di ogni partecipante (passi, sonno, stress, battito a riposo, intensità, …), calcolati con le stesse query di core che usa l'app.
  - La cache si ricostruisce in un worker separato quando arriva una nuova copia dei dati; la copia viene collegata in sola lettura (`immutable=1`) e resta identica byte per byte.
  - **Durante la ricostruzione il server risponde con la cache precedente** e la sostituisce solo quando la nuova è pronta (test `compare.test.ts`: con la seconda ricostruzione ferma, le risposte restano quelle della prima; dopo, cambiano). Se la ricostruzione fallisce, resta la cache precedente.
- **Endpoint** (solo partecipanti): `/api/compare/daily`, `/api/compare/weekly` (intensità, settimane lunedì–domenica), `/api/compare/standing` (frase di riepilogo). Il partecipante che chiede viene escluso dagli altri in base alla sessione, non a un parametro. Le risposte contengono solo aggregati: mediana, 25° e 75° percentile, media, n. L'amministratore vede solo lo stato della cache (`/api/admin/status`), nessun valore.
- **Soglia:** sotto `COMPARE_MIN_PARTICIPANTS` altri partecipanti con dati (predefinita 5, non meno di 5) non si mostra niente, solo «Non ci sono abbastanza partecipanti per un confronto (N con dati, ne servono M)».
- **Giorno valido:** la stessa regola delle 12 ore vale per tutti; il giorno in corso non entra nel valore del periodo (frase di riepilogo) fino a mezzanotte.
- **Nell'app:** «Confronta» è di nuovo visibile, resta uno stato della pagina; nel pannello sotto il grafico «Partecipante tipico (mediana)», «Metà dei partecipanti», «Media (n = …)». Senza connessione: «Il confronto richiede la connessione.»
- **Corretto:** in sviluppo (StrictMode di React) si creavano due worker SQLite sulla stessa copia OPFS, con errori in console; ora c'è un solo client per pagina (`sharedDbClient`).

### Dopo la prova con SYN-G01 (25 novembre)
- **Confronto solo dall'1 al 3 e dal 22 al 24 novembre, mai sonno e SpO2:** non era né il generatore né il calcolo. Il file provato, `data/synthetic-garmin.db` del 24 novembre, aveva solo gli 8 partecipanti predefiniti (`--cohort` è arrivato con la Fase 4).
  - Esclusa SYN-G01, gli altri con dati erano 5 dall'1 al 3 (SYN-G05 finisce il 3) e dal 22 al 24 (SYN-G08 ha solo gli ultimi 3 giorni), 4 negli altri giorni: sotto la soglia. Sonno 2–3, SpO2 2–3: mai 5.
  - Per ogni giorno e metrica, i partecipanti con dati, quelli con giorno valido e l'n dell'API coincidono, sia su quel file sia su quello con `--cohort 100`.
  - Con `--cohort 100` il confronto c'è in tutti i giorni di novembre: n tra 104 e 105 per passi, calorie, battito, stress, Body Battery, respirazione; tra 102 e 103 per il sonno; tra 84 e 85 per la SpO2.
  - La coorte ha dati in ogni ora fino all'ora della generazione, una notte per ogni giorno, la SpO2 per circa l'80% e nessuna HRV (il vívosmart 5 non la misura).
  - `npm run gen:synthetic` ora dice quanti partecipanti ha scritto e fino a quando arrivano i dati, e senza coorte ricorda di usare `-- --cohort 100` per il confronto.
  - `data/synthetic-garmin.db` è stato rigenerato il 25 novembre con `--cohort 100` (108 partecipanti, 175 MB).
- **Nessun altro con dati:** se nessun altro partecipante ha dati per una metrica nel periodo, la frase dice «Nessun altro partecipante ha dati sul sonno in questo periodo»; nel pannello di un giorno, «… in questo giorno». Se gli altri ci sono ma sono pochi resta «Non ci sono abbastanza partecipanti… (N con dati, ne servono M)». La legenda della fascia compare solo se la fascia è disegnata.
- **Intensità per settimana:** le etichette sono l'intervallo («26 ott – 1 nov», «2–8 nov»), su due righe quando non entrano.
- **Frase di riepilogo:** usa solo i giorni conclusi (le settimane complete, per l'intensità) in cui il confronto esiste, sia per il partecipante sia per gli altri, e lo dice: «Novembre, su 24 giorni confrontabili: … Fai più passi di circa 40 partecipanti su 100 (mediana degli altri …)». Il verbo cambia con la metrica: dormi più a lungo, bruci più calorie attive, hai il battito a riposo più alto, respiri più spesso, hai più minuti di intensità, …
- **Test:** coorte continua fino all'ora della generazione (synth); in ogni giorno n = altri partecipanti con dati, sonno e SpO2 compresi; «nessun altro partecipante»; giorni e settimane confrontabili (core e server).

### Tempi e memoria della ricostruzione della cache (`npm run measure:compare -- <database>`)
| | dati reali (`data/gadgetbridge.db`: 7 partecipanti, 855 giorni-persona) | sintetici `--cohort 100` (108 partecipanti, 3.071 giorni-persona) |
|---|---|---|
| Prima dell'ottimizzazione | 4,9 s, picco 123 MB | 58,6 s (tabelle 38,4 s), picco 277 MB |
| **Dopo** | **2,2 s** (tabelle 0,7 + persone 1,5) | **28,0 s** (tabelle 12,8 + persone 15,1) |
| Memoria (RSS) prima / picco / dopo | 52 / 104 / 99 MB | 70 / 278 / 273 MB |
| Dimensione della cache | 0,18 MB | 0,89 MB |

- L'ottimizzazione riguarda la vista dell'attività (contatori → valori al minuto): un solo ordinamento invece di finestre annidate. Tutti i test, compresa la verifica con l'export, danno gli stessi valori. Rende più veloce anche la prima costruzione delle tabelle nel browser.
- Nel worker del server (18 partecipanti sintetici): 3,1 s con la build, 3,5 s con `npm run dev`.
- La memoria dopo la costruzione è quella del processo di misura; nel server il worker termina a ogni ricostruzione e resta solo la cache.
- Il database `--cohort 100` (175 MB) si genera in circa 60 s.

### Verifica dei calcoli con il tuo export
- I valori del codice `legacy-bluetooth`, calcolati dai FIT dello zip, e quelli del nuovo adattatore, calcolati dal database Gadgetbridge dello stesso zip (solo `DEVICE_ID = 4`), **coincidono in tutto** dal 3 al 6 novembre:
  - passi (2.594, 4.450, 704), calorie attive, battito a riposo;
  - minuti per livello di stress, Body Battery caricata e consumata;
  - sonno per fase e punteggio.
- **Tranne la distanza**, che nel formato Gadgetbridge (quello del server) in parte si perde, in due modi:
  - **passi senza nessuna distanza** dopo l'ultima misurata del giorno: la sera del 3/11, dopo le 19:36, 370 passi. Ora vengono stimati (regola sotto);
  - **distanza persa dentro il contatore:** Gadgetbridge somma la distanza per tipo di attività dentro ogni file FIT, ripartendo da zero a ogni file. Se un tipo non ricompare nei file successivi del giorno, la sua distanza sparisce senza che il contatore cali. È il caso del 5/11: tutti i passi sono coperti, ma il contatore dà 2.473,6 m contro i 3.652,42 m dei FIT. Non è visibile nei dati, quindi non si può stimare.
- **Distanza dopo la regola B:**

  | | legacy (FIT) | nuovo | di cui stimata |
  |---|---|---|---|
  | 3/11 (dalle 18:02) | 305,37 m | 251,41 m | 245,74 m |
  | 4/11 | 2.101,02 m | 2.101,02 m | 0 |
  | 5/11 | 3.652,42 m | 2.473,6 m | 0 |
  | 6/11 (fino alle 12:25) | 570,22 m | 570,22 m | 0 |

- **Dove stanno i dati:** in git ci sono solo i valori attesi (`packages/core/tests/fixtures/export-expected.json`). Le righe del bracciale stanno in `data/export-device4.json`, fuori da git, create con `packages/synth/src/export-fixture.ts`. Il test (`export-verification.test.ts`) si salta con un messaggio se il file manca, e controlla in modo stretto tutti i valori, con la distanza della tabella qui sopra.

### Web app
- Accesso, cambio password obbligatorio al primo accesso, area amministratore (stato dei dati, partecipanti, creazione account, reimpostazione, disattivazione, registro).
- Il service worker non salva mai in cache le risposte di `/api`.

### Account legati al partecipante e alla sorgente dei dati (25 novembre)
- **Problema trovato provando i dati reali:** un account era legato solo al numero del partecipante. Creato sui dati sintetici (SYN-G01 = numero 1) e usato con `DATA_FILE=data/gadgetbridge.db`, mostrava i dati reali del partecipante 1. In produzione sarebbe successo con un database del server ricreato o ripristinato con numeri diversi.
- **Altri punti trovati con lo stesso difetto e corretti:**
  - il confronto cercava il richiedente per numero nella cache: con numeri cambiati, la frase di riepilogo dava come «tuo valore» quello di un altro partecipante;
  - la creazione di un account inviava solo il numero: se la copia dei dati cambiava tra l'elenco e il clic, l'account finiva sulla persona sbagliata;
  - l'area amministratore abbinava account e partecipanti solo per numero.
- **Ora:**
  - ogni account salva numero **e codice** del partecipante. All'accesso, a ogni richiesta di dati o di confronto e nell'elenco dell'amministratore il server controlla che vadano ancora insieme nella copia in uso;
  - se non vanno insieme: nessun dato, account «da verificare», avviso nell'area amministratore, voce nel registro (una volta sola). Torna attivo da solo se numero e codice tornano a corrispondere;
  - **codice presente con un altro numero** (database ricreato): nell'area amministratore compare «Ricollega a [codice]». Lo fa solo l'amministratore, con un clic e una conferma, e finisce nel registro («numero 1 → 8»). Il partecipante viene disconnesso e la copia sul suo dispositivo riscaricata. **Codice sparito:** l'account resta bloccato;
  - **account creati prima di questa correzione** (senza codice): «da ricreare», nessun dato, nessuna procedura di recupero;
  - il **database degli account è legato alla sorgente dei dati**: impronta di app, modalità e percorso del file (o URL del backup). Su un'altra sorgente il server non parte e spiega perché. Se i dati sono gli stessi spostati altrove: `npm run admin:accept-source` (nel registro), dopo il quale gli account con numero e codice corrispondenti tornano attivi da soli;
  - **senza `AUTH_DB`** il nome del file degli account dipende dai dati: `auth/vitabridge-synthetic-garmin-auth.db`, `auth/vitabridge-gadgetbridge-auth.db`, così sintetico e reale non si mescolano;
  - **copia nel browser:** appartiene ad account + numero e codice del partecipante + sorgente dei dati. Se uno cambia viene cancellata e riscaricata; se il server legge un'altra sorgente la sincronizzazione non scrive niente. Con un account da verificare o da ricreare l'app mostra il motivo e cancella la copia dal dispositivo.
- **Database dei dati:** mai scritto. Tutte le informazioni nuove stanno nel database degli account. A ogni `npm test` l'impronta (SHA-256) di ogni file in `data/` viene presa prima e dopo i test: un file cambiato o un file nuovo, come un `-wal`, fa fallire l'esecuzione. Ho verificato che fallisce davvero, puntando il controllo su una cartella temporanea.
- **Provato nel browser** sull'app compilata:
  - account creato sul database A, poi il server sul database B con i numeri invertiti: avvio rifiutato con il messaggio;
  - dopo `admin:accept-source` il partecipante vede «Account da verificare» e la copia OPFS sparisce;
  - l'amministratore vede «Ricollega a SYN-G01» e ricollega;
  - il partecipante rientra e riceve i dati di SYN-G01 con il nuovo numero.

### HeartBridge (Fase 5)
- **Una sola app, due marchi:** il marchio si sceglie in compilazione (`vite --mode heartbridge`, `npm run build` compila entrambe: `apps/web/dist` e `apps/web/dist-heartbridge`). Per provare HeartBridge: `npm run dev:heartbridge` (server :8788 con `data/synthetic-gima.db`, Vite :5174; `HEARTBRIDGE_DATA_FILE` per un altro file).
  - `apps/web/src/brand.ts` decide nome, dispositivo («orologio»), sezioni e cosa fare con quelle che l'orologio non misura.
  - **Stress, Body Battery, minuti di intensità, battito a riposo, fase REM e momenti di irrequietezza:** «nascosta» oggi, oppure «non disponibile» (sezione visibile con «Non disponibile con questo dispositivo»), da `missing` in `brand.ts`. Il battito a riposo non viene stimato. Senza REM: niente anello, riquadri, legende, barre né riga REM nel grafico delle fasi (`lib/sleep-stages.ts`); «Sveglio» resta, perché la pausa tra due segmenti è un dato vero. Con «non disponibile» resta solo il riquadro REM con l'avviso.
  - **Colori:** corallo caldo (`#cf5539`, scuro `#f08d6a`) con icona a cuore e tracciato. In HeartBridge errori e avvisi diventano cremisi (`#b80049`) e le calorie ambra, così il corallo non si confonde con il rosso.
  - Se l'app e il server non sono la stessa app, la pagina lo dice e non va avanti.
- **Adattatore Gima** (`packages/core/src/gima/views.ts`): le stesse tabelle dell'app di VitaBridge.
  - **Passi:** ogni blocco di 30 minuti è distribuito sui suoi 6 intervalli di 5 minuti, con i totali invariati. I «minuti attivi» non esistono con i blocchi: in HeartBridge non compaiono.
  - **Battito:** circa ogni 18 minuti; il giorno valido resta quello delle 12 ore con battito.
  - **Sonno:** una notte in più segmenti è una notte sola, le pause sono sveglio, un codice di fase sconosciuto non conta. Sui dati veri profondo e leggero coincidono con i totali dell'orologio.
  - **Valori non validi:** filtrati in un solo punto (`GIMA_VALID`): temperatura fuori da 30–43 °C, 0 per battito, pressione, HRV, SpO2, respirazione e durata, `ai_heart` sopra 300.
  - **Distanza:** `DISTANCE_CM` contiene **metri**, nonostante il nome. L'app Android salva `sportDistance` dell'orologio così com'è e i dati veri danno 0,76 per passo. L'adattatore converte; è da confermare con il gestore del server.
- **Pagine:**
  - **Home:** ECG (ultima registrazione, valori, valutazione del dispositivo, anteprima del tracciato) e Pressione (ultima misura, media degli ultimi 7 giorni); temperatura e HRV/CVRR tra le tessere.
  - **Grafici:** Pressione (giorno: sistolica e diastolica per misura; settimana e mese: minima–massima per giorno con la media); Temperatura (solo valori validi, con la nota); HRV dai valori del giorno con il CVRR. Nessuna classificazione clinica.
  - **ECG (in Grafici, 26 novembre):** una metrica come le altre, con Giorno, Settimana e Mese; non c'è più la voce ECG nel menu.
    - **Settimana e Mese:** a sinistra il riepilogo (numero di registrazioni, conteggio per valutazione con barra, battito medio delle registrazioni che lo hanno, ultima registrazione); a destra un punto per registrazione (altezza = battito; verde ritmo normale, ambra le altre valutazioni; cerchio vuoto vicino all'asse se il battito manca), con lo stesso asse delle date e lo stesso riquadro al passaggio degli altri grafici del periodo (data e ora, battito o «non registrato», valutazione), poi l'elenco. Un punto o una riga aprono il Giorno di quella registrazione.
    - **Giorno:** a sinistra i valori della registrazione e la valutazione, a destra il tracciato con l'avviso «Scala dei tempi da confermare…», l'asse in «unità del dispositivo» (100 per quadretto grande), i valori limitati a ±500 e i parametri usati. Con più registrazioni nello stesso giorno, un pulsante per orario.
    - **Tracciato (26 novembre):** gli stessi gesti degli altri grafici. Un dito o il mouse mostrano una linea con tempo e valore («3,1 s · 9 unità», nessun calcolo dal tracciato); un dito in verticale fa scorrere la pagina; due dita, Ctrl + rotella o i pulsanti cambiano la velocità della carta; il trascinamento col mouse e la rotella orizzontale spostano; il doppio tocco o doppio clic va a 50 mm/s e poi torna a 25.
      - **Velocità:** 12,5 · 25 · 50 · 100 mm/s, con 25 come predefinita; il pizzico si ferma sul passo più vicino. Il quadretto resta della stessa grandezza sullo schermo e cambia il tempo che rappresenta: a 50 mm/s 0,02 e 0,1 s.
      - **Sotto il tracciato:** una striscia con tutta la registrazione e la parte visibile evidenziata, da trascinare o toccare per spostarsi (anche su desktop); poi la barra sempre visibile «25 mm/s · 0–5,7 s» con −, + e «25 mm/s» per tornare alla scala standard.
    - **Valutazioni:** le etichette sono brevi («Ritmo normale», «Possibili battiti prematuri atriali»…); la frase «Valutazioni automatiche del dispositivo, non sono diagnosi mediche» compare una volta per riquadro (riepilogo, valori, elenco).
    - La sezione ECG della Home apre Grafici → ECG sul giorno dell'ultima registrazione.
- **Confronto:** passi, calorie, sonno, SpO2, respirazione, HRV. Pressione e temperatura sono escluse, e il server rifiuta anche le metriche che l'orologio non misura (`compareMetrics` in `datasets.ts`).
- **Prova nel browser** (`data/synthetic-gima.db` con 100 partecipanti in più): Home, tutte le sezioni, ECG con scorrimento e zoom, Dispositivi senza batteria, «Confronta» su passi, HRV e sonno; 390 px e desktop, chiaro e scuro; nessuno scorrimento orizzontale, console pulita. VitaBridge invariata (stessa prova di «Confronta» su 9 metriche).

### Frequenza e unità dell'ECG (26 novembre)
- **Codice Gima** (`GIMASportpixSystem-Nuovo_BE.zip`, solo letto):
  - `SynchronizationActivity.scaleSamples` filtra i campioni dell'orologio, ne fa la **media ogni 3**, li **divide per 40** e li **limita a ±500**;
  - `Cardiograph3View` dice «采样率250 … 3个数据取平均值为一个» (frequenza 250, 3 valori mediati in uno) e disegna un punto ogni 0,012 s, cioè 83,33 punti al secondo;
  - in quella vista 1000 unità = 1 mV, quindi forse µV, ma non è confermato;
  - `duration_ms` è il tempo dall'inizio della misura all'invio, non la durata del tracciato. Nelle registrazioni scaricate con la sincronizzazione battito, pressione e HRV sono salvati a 0.
- **Verifica sui 4 tracciati veri con il battito registrato:** il battito ricavato dai picchi R, alle tre frequenze candidate, confrontato con quello registrato dal dispositivo (qui solo gli scarti medi, non i valori della persona):

  | Frequenza | Scarto medio dal battito registrato |
  |---|---|
  | **83,33 Hz (250/3)** | **1,6 bpm** |
  | 75 Hz | 7,8 bpm |
  | `sample_count` / `duration_ms` | 10,1 bpm |

  `ai_heart` non è un riferimento utile: spesso è lontano dal battito, o sopra 300.
- **Scelta:** 83,33 Hz come predefinito, in `packages/core/src/gima/ecg.ts`, segnato come da confermare; tracciati di circa 61 s. Finché non è confermato, il visualizzatore mostra l'avviso.

### Temperatura (26 novembre)
- **Cosa fa l'app Android:** `SynchronizationActivity` (righe 723–740) unisce due campi del protocollo, `tempIntValue + "." + tempFloatValue`, e li converte in numero. Non perde la parte intera: la prende dal campo `tempIntValue` del record.
- **Cosa c'è nei dati veri:** le 488 temperature non valide valgono **tutte esattamente 0,15** (parte intera 0, decimali «15»). Se fosse persa la parte intera, i decimali varierebbero come in quelle valide (da ,0 a ,9).
- **Conclusione:** è più probabile un valore fisso dell'orologio o della libreria quando la misura non c'è, non una parte intera persa dall'app. Da chiedere al gestore del server. Intanto l'app mostra solo le temperature valide (30–43 °C).
- **Altro difetto possibile, nei soli dati:** l'unione come testo confonde i decimali a due cifre (36,05 diventerebbe «36.5»). Nei dati veri i decimali delle temperature valide sono sempre a una cifra.

### Menu fisso del telefono (26 novembre)
- **Cosa succedeva:** lo spazio in fondo alla pagina (80 px) bastava per la fine della pagina, ma un elemento portato in vista (dal browser, con Tab, con `scrollIntoView`) si allineava al bordo dello schermo e finiva sotto il menu in basso (65 px). Lo stesso in alto, sotto l'intestazione fissa e la barra delle metriche di Grafici.
- **Ora:**
  - il menu ha un'altezza fissa (`--bottom-nav` in `index.css`: 4rem, il bordo e l'area sicura);
  - lo spazio in fondo al contenuto è esattamente quello;
  - `scroll-padding-bottom` e `scroll-padding-top` fermano gli elementi portati in vista sopra il menu e sotto l'intestazione.
- **Verifica:** la prova nel browser porta in vista ogni riquadro, dall'alto e dal basso, e controlla che non finisca sotto nessuno dei due, in tema chiaro e scuro.

### Grafico del sonno con i dati Gima (26 novembre)
- **Cosa succedeva:** con le sovrapposizioni Battito / Ossigenazione / Respirazione la linea compariva solo in 2–3 punti, ma il riquadro al passaggio mostrava valori anche altrove. Il grafico spezzava la linea fra due misure distanti più di 15 minuti (valore fisso, pensato per il Garmin al minuto); i Gima misurano circa ogni 18 minuti nei dati sintetici e ogni 10 in quelli veri. Quasi ogni misura restava sola, e un punto solo non disegna nessuna linea; il riquadro però la trovava, perché cercava entro 15 minuti.
- **Ora** (`packages/core/src/line-gaps.ts`):
  - la linea si spezza dopo una pausa di più di **2,5 volte la mediana degli intervalli di quella serie**; il vecchio valore fisso di ogni grafico resta come minimo, così le serie al minuto di VitaBridge si spezzano dove prima;
  - le misure isolate sono disegnate come **punti**;
  - il riquadro al passaggio arriva fino a metà della soglia e mostra solo misure disegnate.
  - Vale per tutti i grafici giornalieri: sonno, battito, SpO2, respirazione, temperatura, pressione e «Attività e sonno». L'HRV di HeartBridge ha solo Settimana e Mese.
- **Su 14 giorni dei dati sintetici di HeartBridge:**
  - nel grafico del sonno prima erano invisibili 160 misure di battito, 116 di SpO2 e 117 di respirazione; ora sono tutte su una linea, tranne una misura isolata di SpO2 e una di respirazione, disegnate come punti;
  - battito, SpO2 e respirazione del giorno non avevano misure invisibili;
  - la temperatura (solo valori validi, più radi) ora unisce i suoi punti.
- **VitaBridge:**
  - tutti i grafici del giorno hanno lo stesso SVG di prima (passi, calorie, battito, SpO2, respirazione, stress, Body Battery, «Attività e sonno»);
  - nel grafico del sonno: battito e respirazione hanno la stessa linea di prima;
  - la SpO2 notturna arriva ogni 15 minuti, quindi la soglia diventa 37,5 minuti: una sola misura mancante non spezza più la linea (come nel grafico SpO2 del giorno, che univa già fino a 60 minuti). Deciso di tenerla così, senza eccezioni.
- **Asse della SpO2:** al massimo 100 %, ovunque (sovrapposizione nel sonno, giorno, settimana e mese); prima nel sonno arrivava a 120.
- **Sfondo del grafico delle fasi:** copre tutte le righe mostrate (prima la riga «Sveglio» ne restava fuori) e le linee sovrapposte restano dentro l'area; vale anche per VitaBridge.
- **Asse della temperatura:** resta 34–39 °C, ma si allarga se un valore valido (30–43 °C) ne esce.
- **Prova nel browser:**
  - HeartBridge 108 verifiche su 14 notti, VitaBridge 149: righe e testi, sfondo, linea dentro l'area, ogni misura isolata disegnata come punto, asse SpO2 ≤ 100, riquadro al passaggio solo su misure disegnate, nessun REM né irrequietezza in HeartBridge (presenti in VitaBridge);
  - 390 px e desktop, chiaro e scuro, console pulita.

### Date e riquadri (26 novembre)
- **Date:** si scrivono come frasi italiane, con la sola prima lettera maiuscola: «Giovedì 26 novembre 2026», «Lun 23 nov – dom 29 nov», «Novembre». Prima la classe CSS `capitalize` rendeva maiuscola ogni parola («Giovedì 26 Novembre 2026»).
  - La maiuscola iniziale la mettono i formattatori di `packages/core/src/format.ts` (`fmtDayLong`, `fmtDayTitle`, `fmtMonth`, il nuovo `fmtWeekTitle`).
  - Le pagine non usano più `capitalize`.
  - Test in `time-zone.test.ts`, nei due fusi orari.
- **Riquadri:** in una griglia a due colonne l'ultimo riquadro dispari occupa tutta la riga. In HeartBridge, senza REM, «Sveglio» è a tutta larghezza sotto Profondo e Leggero, nel giorno e nella media di settimana e mese. Tre riquadri su una riga a 390 px avrebbero troncato «5 h 31 min».
  - Lo stesso in Dispositivi, solo sul telefono: «Ultimo caricamento dal telefono», terzo campo dopo la batteria in VitaBridge.
- **Prova nel browser:** 45 pagine per app (Home, Dispositivi, Impostazioni, ogni metrica in Giorno, Settimana e Mese), 390 px e desktop. Nessuna data con il mese maiuscolo (testo come appare, CSS compreso), nessun riquadro da solo su mezza riga; console pulita.

### Fascia del sonno, intervallo dei grafici del giorno, grafico delle fasi (26 novembre)
- **Fascia del sonno** (battito, SpO2, respirazione e, in VitaBridge, Body Battery):
  - il sottotitolo dice «La fascia evidenziata indica il sonno» e la legenda ha la voce «Sonno», con il colore della fascia;
  - l'etichetta «Sonno» compare in alto dentro la fascia solo se c'è spazio (a 390 px, se la fascia è larga almeno 40 px);
  - al passaggio del mouse o al tocco dentro la fascia, il riquadro aggiunge «Durante il sonno (23:10–07:06)» con gli orari veri, anche dove non c'è un valore;
  - colori in `index.css` (`--sleep-band`, `-edge`, `-text`): nel tema scuro la fascia è più chiara della scheda, non più scura; un bordo su ogni lato la distingue in entrambi i temi.
- **Grafici del giorno su 00:00–24:00:** la SpO2 andava dalle 18:00 del giorno prima. Ora tutti i grafici del giorno coprono 00:00–24:00: attività e sonno, passi, calorie, battito, stress, Body Battery, SpO2, respirazione, pressione, temperatura. La notte intera si vede nel grafico del sonno con «Ossigenazione».
  - Anche i riquadri della SpO2 del giorno (minima, massima, letture, media) usano 00:00–24:00 e coincidono con la barra di quel giorno in Settimana e Mese e con il confronto.
  - **Tessera SpO2 della Home** (entrambe le app): media sul sonno reale di quella notte, lo stesso periodo della fascia e del grafico delle fasi, con il nome «Media notturna». Coincide con «SpO₂ media» sotto il grafico del sonno. Se quella notte non c'è sonno registrato, o non ci sono misure SpO2 durante il sonno, mostra la media 00:00–24:00 con il nome «Media del giorno» (`spo2AvgOf` in `day-data.ts`). Prima era la media dalle 18:00 del giorno prima.
- **Grafico delle fasi del sonno:**
  - lo spazio dell'asse destro e della riga sopra il grafico è sempre riservato (`lib/sleep-overlay.ts`): attivando o togliendo una misura il grafico non si sposta;
  - scala fissa per misura, allargata solo se un valore esce: battito 40–100 bpm, SpO2 85–100 % (mai sopra 100), respirazione 8–24 resp/min; l'unità sta in alto («100 bpm») e ci sono i valori intermedi;
  - riquadri sotto il grafico: minimo, massimo e media della misura scelta; senza misura, le medie notturne di battito, SpO2 e respirazione, solo quelle con dati; in VitaBridge resta «Momenti di irrequietezza»;
  - asse orizzontale dall'ora intera prima dell'addormentamento all'ora intera dopo il risveglio (23:10–07:06 → 23:00–08:00), un'etichetta per ogni ora compresa la prima; barre e linee negli orari veri;
  - i pulsanti Battito, Ossigenazione e Respirazione dicono se sono attivi (`aria-pressed`).
- **VitaBridge:** confrontando l'SVG con l'ultimo commit, passi, calorie, stress e «Attività e sonno» sono identici. Battito, respirazione e Body Battery hanno le stesse linee dei dati: cambiano solo fascia, bordi ed etichetta. Cambiano come richiesto la SpO2 del giorno e il grafico delle fasi.
- **Prova nel browser:** HeartBridge 124 verifiche su 14 notti, VitaBridge 152 su 13, 390 px e desktop, tutte passate. Rifatta anche la prova delle date e dei riquadri.

### Dati per lo sviluppo
- `data/gadgetbridge.db` e `data/GimaDB.db`: copie reali, mai in git, aperte solo in sola lettura.
- `npm run gen:synthetic` crea `data/synthetic-garmin.db` (8 partecipanti) e `data/synthetic-gima.db` (6), con gli schemi reali e alcune sezioni volutamente vuote. `data/synthetic-gima.db` è stato rigenerato il 26 novembre con `--cohort 100` (106 partecipanti): ECG a 83,33 Hz, notti divise in due segmenti, distanza in metri come i dati veri. Con `-- --cohort N` si aggiungono N partecipanti Garmin con profili diversi (`SYN-C001`…): **servono per provare il confronto**, perché con i soli 8 predefiniti quasi tutti i giorni hanno meno di 5 altri partecipanti. Quello in `data/` oggi ha `--cohort 100`.
- Per provare: copia `.env.example` in `.env`, imposta `ADMIN_PASSWORD`, poi `npm run dev`. Senza `AUTH_DB` ogni file di dati ha il suo file degli account; gli account creati prima del 25 novembre sono da ricreare (il vecchio `auth/vitabridge-auth.db` si può cancellare).

## Decisioni prese

### Piano multiutente (23 novembre)
- **Confronto:** restano mediana e fascia 25°–75° percentile; la media si aggiunge nel pannello sotto il grafico, accanto alla mediana (Fase 4).
- **Giorno valido:** 12 ore distinte con battito, configurabile, un'unica definizione per tutti, anche per Gima.
- **«Sincronizza»:** copia nuova se più vecchia di 5 minuti; aggiornamento automatico ogni 60. Entrambi configurabili.
- **Pagina Allenamenti:** si toglie da `main`, resta in `legacy-bluetooth`.
- **Driver SQLite del server:** `node:sqlite` invece di `better-sqlite3`, perché npm 12 blocca gli script di installazione che servirebbero a quest'ultimo.
- **Generatore sintetico Garmin:** riusa generatore demo e `fit-to-server`, così i dati finti hanno le stesse particolarità di Gadgetbridge.
- **Amministratori:** creazione e recupero solo con i comandi sul server, nessuna procedura di recupero dal web.
- **Obiettivi** sul server (`/api/me/settings`), **«Confronta» nascosto** fino alla Fase 4 (24 novembre).
- **Distanza (regola B, 25 novembre):** si stima solo dove i passi non hanno nessuna distanza misurata dopo di loro nello stesso giorno: passi × passo medio della persona. Il passo medio si calcola dai suoi minuti coperti dalla distanza, se sono almeno 60 minuti e 1.000 passi; altrimenti vale il **valore predefinito di 75 cm**. Nell'interfaccia è indicata come «stimata» o «in parte stimata». È la stessa regola per tutti, anche nel confronto, perché sta nelle query di core.
- **Sincronizzazione:** finestra di 3 giorni per tabella e per dispositivo, conteggi confrontati a ogni sincronizzazione (24 novembre).
- **Grafici del giorno (26 novembre):** tutti su 00:00–24:00, SpO2 compresa (anche i suoi riquadri); SpO2 della Home = media notturna sul sonno reale, altrimenti «Media del giorno»; con la fascia del sonno evidenziata e nominata; nel grafico delle fasi spazio dell'asse destro fisso, scale fisse per misura, riquadri che seguono la misura scelta, asse a ore intere attorno alla notte.
- **Linee dei grafici (26 novembre):** si spezzano dopo 2,5 volte la mediana degli intervalli della serie (mai meno del vecchio valore fisso), misure isolate come punti; nessuna eccezione per la SpO2 notturna di VitaBridge, coerente con il grafico SpO2 del giorno. SpO2 al massimo 100 %; REM e momenti di irrequietezza nascosti in HeartBridge.
- **ECG in Grafici (26 novembre):** metrica con Giorno / Settimana / Mese al posto della pagina e della voce di menu; etichette delle valutazioni senza «(secondo il dispositivo)», con la nota sulle diagnosi una volta per riquadro.
- **HeartBridge (26 novembre):** corallo e icona a cuore, sezioni mancanti configurabili («nascosta» oggi), ECG a 83,33 Hz da confermare con l'avviso, asse in unità del dispositivo, pressione e temperatura fuori dal confronto, battito a riposo non stimato.
- **Account e sorgente dei dati (25 novembre):** numero e codice del partecipante controllati su ogni richiesta; ricollegamento solo dall'amministratore, con un clic; account senza codice da ricreare; database degli account legato alla sorgente, `admin:accept-source` per accettarne una spostata; copia del browser legata ad account, partecipante e sorgente.
- **Confronto (Fase 4, 25 novembre):** parole «partecipante tipico (mediana)», «metà dei partecipanti», «media (n = …)»; il giorno in corso è escluso dal valore del periodo fino a mezzanotte; «Confronta» resta uno stato della pagina; il calcolo è sul server, con la cache precedente usata finché la nuova non è pronta.
- **Frase di riepilogo (25 novembre):** solo sui giorni (settimane) confrontabili, detto nella frase; «Hai più minuti di circa 40 partecipanti su 100» con il verbo della metrica; messaggio esplicito quando nessun altro ha dati.

### Lavoro precedente (ancora valide)
- **Mezzanotte nel formato del server:** si mantiene il comportamento di Gadgetbridge (i totali di mezzanotte possono essere sovrascritti dal file successivo).
- **«Metà degli utenti»** per la fascia 25°–75° percentile (dalla Fase 4 «metà dei partecipanti»).
- **Scale fisse:** stress e Body Battery restano su 0–100.

## Problemi aperti
- **Domanda per il gestore del server:** l'app del telefono può inviare la distanza completa? Oggi i dati arrivano nel formato Gadgetbridge, che perde parte della distanza: valori −1, e somma per tipo di attività dentro ogni file FIT. Servirebbe la distanza di ogni tipo cumulata sulla giornata, o i file FIT originali.
- **Dati veri del tuo bracciale già su GitHub** (repository pubblico), trovati il 24 novembre; da decidere che cosa fare, la cronologia non è stata toccata:
  - `tests/sleep.test.ts` (in `main`, `legacy-bluetooth`, `formato-server`; in `multiutente` spostato in `packages/core/tests/sleep.test.ts`): la notte 2→3 novembre 2026, con numero di serie del bracciale, orari di inizio e fine, le 11 fasi con l'orario, punteggio 77;
  - `tests/metrics.test.ts` e un commento di `metrics.ts`: metabolismo a riposo 1.899 kcal/giorno e 1.404 kcal «a riposo» alle 17:44 del 3/11.
- **Formato di `GET /admin/backup`:** da confermare con il gestore del server. Oggi si accetta un file SQLite, anche compresso con gzip.
- **Da confermare con il gestore del server:**
  - frequenza dell'ECG (83,33 Hz) e unità dei campioni (forse µV);
  - `DISTANCE_CM` in metri;
  - il valore 0,15 °C delle temperature (`packages/core/src/gima/ecg.ts`, `gima/views.ts`).
- **Da discutere: soglia del confronto.** Con soglia 5 la mediana coincide spesso con il valore di un singolo partecipante (con 5 valori è il terzo). Quando i partecipanti saranno molti, valutare di alzare la soglia: è già configurabile con `COMPARE_MIN_PARTICIPANTS` (predefinita 5, non meno di 5).
- **Tempo della cache del confronto con molti partecipanti:** cresce circa in proporzione ai giorni-persona (28 s per 108 persone × 28 giorni). Non blocca le risposte (si usa la cache precedente), ma con centinaia di partecipanti e mesi di dati si potrebbe aggiornare solo i giorni nuovi, come nel browser.
- **Avviso del worker SQLite** in console («Ignoring inability to install OPFS sqlite3_vfs»): innocuo, l'app usa `opfs-sahpool`. C'era già prima.
- **Grafici della vista Giorno** senza etichetta dell'obiettivo a destra; **legenda delle fasce dello stress** nascosta quando il confronto è attivo.
