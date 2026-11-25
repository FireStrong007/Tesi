# Stato dei lavori

Ultimo aggiornamento: 25 novembre 2026, ramo `multiutente`.

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
| 5. HeartBridge | **prossima** |
| 6. Pubblicazione e documentazione | da fare |

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

### Dati per lo sviluppo
- `data/gadgetbridge.db` e `data/GimaDB.db`: copie reali, mai in git, aperte solo in sola lettura.
- `npm run gen:synthetic` crea `data/synthetic-garmin.db` (8 partecipanti) e `data/synthetic-gima.db` (6), con gli schemi reali e alcune sezioni volutamente vuote. Con `-- --cohort N` si aggiungono N partecipanti Garmin con profili diversi (`SYN-C001`…): **servono per provare il confronto**, perché con i soli 8 predefiniti quasi tutti i giorni hanno meno di 5 altri partecipanti. Quello in `data/` oggi ha `--cohort 100`.
- Per provare: copia `.env.example` in `.env`, imposta `ADMIN_PASSWORD`, poi `npm run dev`.

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
- **Frequenza di campionamento e unità degli ECG:** 250 Hz secondo il codice Gima, circa 74 Hz secondo `duration_ms` dei dati reali (Fase 5).
- **Da discutere: soglia del confronto.** Con soglia 5 la mediana coincide spesso con il valore di un singolo partecipante (con 5 valori è il terzo). Quando i partecipanti saranno molti, valutare di alzare la soglia: è già configurabile con `COMPARE_MIN_PARTICIPANTS` (predefinita 5, non meno di 5).
- **Tempo della cache del confronto con molti partecipanti:** cresce circa in proporzione ai giorni-persona (28 s per 108 persone × 28 giorni). Non blocca le risposte (si usa la cache precedente), ma con centinaia di partecipanti e mesi di dati si potrebbe aggiornare solo i giorni nuovi, come nel browser.
- **Avviso del worker SQLite** in console («Ignoring inability to install OPFS sqlite3_vfs»): innocuo, l'app usa `opfs-sahpool`. C'era già prima.
- **Grafici della vista Giorno** senza etichetta dell'obiettivo a destra; **legenda delle fasce dello stress** nascosta quando il confronto è attivo.
