# Stato dei lavori

Ultimo aggiornamento: 23 novembre 2026, ramo `formato-server`.

## Cosa è stato fatto

### Confronto con gli altri utenti («Confronta»)
- Pulsante «Confronta» nei grafici mensili di tutte le categorie: sovrappone la mediana degli altri utenti («utente tipico») e la fascia 25°–75° percentile («metà degli utenti»).
- Giudizio tra persone: il valore del periodo di ogni persona e il percentile dell'utente tra loro. Serve un minimo di 5 utenti e di 7 giorni validi.
- Giorno valido: bracciale indossato almeno 10 ore. È definito una sola volta, in `metrics.ts`, e vale sia per l'utente sia per gli altri.
- Intensità confrontata per settimane da lunedì a domenica (obiettivo 150 min).
- I valori di «Tu» passano per il formato del server, come quelli degli altri (`user-mirror.ts`), così entrambi seguono le stesse regole.
- Pannello sotto il grafico con giorno, Tu, utente tipico e metà degli utenti, al posto del riquadro che segue il mouse.

### Grafici di settimana e mese
- **Periodi:** la settimana va da lunedì a domenica e il mese dal 1° all'ultimo giorno. I giorni futuri sono spazi vuoti.
- **Navigazione:** ogni vista ha solo le frecce del suo periodo. Il calendario c'è solo nella vista Giorno.
- **Aspetto:**
  - etichetta «Obiettivo» a destra, fuori dal grafico;
  - asse delle ordinate appena sopra i dati;
  - date con il mese («27 ott»);
  - nessuna linea della media per passi e sonno.
- **Giorno in corso** (o settimana, per l'intensità): barra più chiara e tratteggiata, esclusa dal confronto fino a fine giornata. Vale anche per il sonno, non per l'HRV.
- **Stress del mese:** l'altezza è la media del giorno; la barra è divisa nei colori delle fasce (blu rilassato, verde leggero, arancione moderato, rosso elevato) in proporzione al tempo passato in ciascuna.

### Dati e database
- **Profilo Demo separato** (`user.is_demo`): la demo non si mescola con i dati reali e non entra mai nei confronti o negli invii.
- **Controllo dello schema all'avvio** (`checkSchema`): ricrea tabelle e colonne mancanti, lo registra nel Log e rielabora i file falliti per quel motivo.
- **Contatori giornalieri** azzerati alla mezzanotte del bracciale (`local_timestamp`). La migrazione 7 fa ricalcolare tutto una volta all'avvio, con l'avviso «Dati ricalcolati».

### Formato del server di ricerca
- **`src/lib/server/`:**
  - schema del professore;
  - conversione FIT → righe Gadgetbridge (`fit-to-server.ts`), verificata riga per riga su un export reale;
  - viste che mostrano le tabelle del server come quelle dell'app (`views.ts`);
  - sorgente di confronto su uno o più database del server (`server-source.ts`).
- **Fuso dello studio:** `Europe/Rome` per tutti (`src/lib/time-zone.ts`). Il confronto sul server si rifiuta di partire se Node non gira con quel fuso; i test girano sempre in `Europe/Rome`.

## File principali toccati
- `src/pages/charts.tsx`: viste giorno, settimana e mese, configurazione del confronto, pannello.
- `src/components/charts/charts.tsx`: `BarChart` con `sideLabels`, `tightY`, `info`, barre `partial` e `future`.
- `src/components/page.tsx`: `periodRange` e `DateNav`.
- `src/lib/format.ts`: `fmtDayMonth`, `fmtDayTitle`, `fmtMonth`.
- `src/lib/comparison/*`, `src/lib/server/*`, `src/lib/time-zone.ts`.
- `src/lib/db/importer.ts`, `src/lib/db/schema.ts`, `src/lib/db/migrate.ts`.
- Test: `tests/comparison.test.ts`, `separation.test.ts`, `server.test.ts`, `server-synthetic.test.ts`, `server-format.test.ts` (quest'ultimo solo con `GB_EXPORT`).

## Decisioni prese
- **Mezzanotte nel formato del server:** si mantiene il comportamento di Gadgetbridge, cioè i totali di mezzanotte possono essere sovrascritti dal file successivo. È un limite noto, documentato.
- **Identificativo del bracciale:** il numero di serie Garmin, non il MAC. Il MAC è nascosto da Web Bluetooth e il vívosmart 5 lo cambia a ogni associazione.
- **«Metà degli utenti» invece di «La maggior parte»:** la fascia è il 25°–75° percentile, cioè metà degli utenti.
- **Scale fisse:** lo stress e la Body Battery restano su 0–100 anche con l'asse stretto.
- **`data/` e `*.db` sono in `.gitignore`:** contengono i database reali dei server, con dati di persone.

## Problemi aperti
- **Domande per il professore:** il numero di serie come identificativo del dispositivo; i totali di mezzanotte sovrascritti.
- **Fonte del confronto:** l'app usa ancora la coorte sintetica (`DemoComparisonSource`). Manca il collegamento al server reale: API e protocollo di invio.
- **`BASE_ACTIVITY_SUMMARY`** non è convertita nel formato del server.
- **Valore del periodo:** il giorno in corso entra nella frase di riepilogo appena raggiunge 10 ore indossate, quindi con dati parziali. Va deciso se escluderlo fino a mezzanotte; la regola vale anche per gli altri utenti.
- **Fuso nel browser:** l'app raggruppa ancora i giorni con il fuso del dispositivo, non con `Europe/Rome`. Per chi è in Italia è identico.
- **Grafici della vista Giorno** (passi e calorie cumulativi, battito, ecc.): non hanno ancora l'etichetta dell'obiettivo a destra.
- **Legenda delle fasce dello stress:** nascosta quando il confronto è attivo.
- **Nuovo piano multiutente** (`docs/piano-multiutente.md`): web app che leggono i server in sola lettura, VitaBridge e HeartBridge, login per partecipante e amministratore. Non è ancora iniziato. I database reali per lo sviluppo sono in `data/`, esclusi da git.
