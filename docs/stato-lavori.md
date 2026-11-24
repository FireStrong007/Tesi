# Stato dei lavori

Ultimo aggiornamento: 24 novembre 2026, ramo `multiutente`.

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
| 3. VitaBridge sui dati del server | **prossima** |
| 4. Confronto con gli altri partecipanti | da fare |
| 5. HeartBridge | da fare |
| 6. Pubblicazione e documentazione | da fare |

## Cosa c'è oggi

### Struttura
- **`packages/core`:** calcoli, formati, fuso, query sui dati, confronto, formato del server e catalogo delle due app (`datasets.ts`). Non può usare funzioni del browser né di Node.
- **`packages/server`:** server Node (Hono, `node:sqlite`, Node ≥ 24).
- **`packages/synth`:** codice FIT, generatore demo e generatore di database sintetici, solo per sviluppo e test.
- **`apps/web`:** la web app. Il partecipante vede ancora l'app locale, con Bluetooth e demo, fino alla Fase 3.

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

### Web app
- Accesso, cambio password obbligatorio al primo accesso, area amministratore (stato dei dati, partecipanti, creazione account, reimpostazione, disattivazione, registro).
- Il service worker non salva mai in cache le risposte di `/api`.

### Dati per lo sviluppo
- `data/gadgetbridge.db` e `data/GimaDB.db`: copie reali, mai in git, aperte solo in sola lettura.
- `npm run gen:synthetic` crea `data/synthetic-garmin.db` (8 partecipanti) e `data/synthetic-gima.db` (6), con gli schemi reali e alcune sezioni volutamente vuote.
- Per provare: copia `.env.example` in `.env`, imposta `ADMIN_PASSWORD`, poi `npm run dev`.

## Decisioni prese

### Piano multiutente (23 novembre)
- **Confronto:** restano mediana e fascia 25°–75° percentile; la media si aggiunge nel pannello sotto il grafico, accanto alla mediana (Fase 4).
- **Giorno valido:** 12 ore distinte con battito, configurabile, un'unica definizione per tutti, anche per Gima (Fase 3; oggi il codice usa ancora 10).
- **«Sincronizza»:** copia nuova se più vecchia di 5 minuti; aggiornamento automatico ogni 60. Entrambi configurabili.
- **Pagina Allenamenti:** si toglie da `main`, resta in `legacy-bluetooth`.
- **Driver SQLite del server:** `node:sqlite` invece di `better-sqlite3`, perché npm 12 blocca gli script di installazione che servirebbero a quest'ultimo.
- **Generatore sintetico Garmin:** riusa generatore demo e `fit-to-server`, così i dati finti hanno le stesse particolarità di Gadgetbridge.
- **Amministratori:** creazione e recupero solo con i comandi sul server, nessuna procedura di recupero dal web.

### Lavoro precedente (ancora valide)
- **Mezzanotte nel formato del server:** si mantiene il comportamento di Gadgetbridge (i totali di mezzanotte possono essere sovrascritti dal file successivo).
- **«Metà degli utenti»** per la fascia 25°–75° percentile.
- **Scale fisse:** stress e Body Battery restano su 0–100.

## Problemi aperti
- **Formato di `GET /admin/backup`:** da confermare con il gestore del server. Oggi si accetta un file SQLite, anche compresso con gzip.
- **Frequenza di campionamento e unità degli ECG:** 250 Hz secondo il codice Gima, circa 74 Hz secondo `duration_ms` dei dati reali (Fase 5).
- **Valore del periodo nel confronto:** il giorno in corso entra nella frase di riepilogo appena è valido, quindi con dati parziali. Da decidere nella Fase 4.
- **Fuso nel browser:** l'app raggruppa ancora i giorni con il fuso del dispositivo. Passa a `Europe/Rome` esplicito nella Fase 3.
- **Verifica dei calcoli con il tuo export** (`gadgetbridge_20261106122516.zip`): serve nella Fase 3, da mettere in `data/`.
- **Avviso del worker SQLite** in console («Ignoring inability to install OPFS sqlite3_vfs»): innocuo, l'app usa `opfs-sahpool`. C'era già prima.
- **Grafici della vista Giorno** senza etichetta dell'obiettivo a destra; **legenda delle fasce dello stress** nascosta quando il confronto è attivo.
