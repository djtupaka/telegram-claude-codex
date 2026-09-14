# Verifica gruppo Dev — 14 settembre 2026

Base di partenza del bot: `2d629cf`. Repository `telegram-claude-codex`, branch `main`. Ripresa della conversazione autorizzata sugli argomenti Telegram e sull'ordine degli allegati. Nessun rilascio PremelOne ripetuto.

## Evidenze

- Baseline: `bun test` → **196 pass, 0 fail**, 494 assertion, 26 file.
- Diff completo: `bun test` → **266 pass, 0 fail**, 753 assertion, 39 file.
- `bun run typecheck` → exit 0.
- `bun run lint` → exit 0, 111 file verificati, nessuna correzione; due avvisi di complessità nelle funzioni di orchestrazione `runSinglePrompt` e `executeAttempt`.
- `git diff --check` → exit 0.
- Integrazione `createBot.handleUpdate` in una copia temporanea di `src`: autorizzazioni, isolamento fra argomenti, callback scadute e rifiutate, blocco Codex in modalità «chiedi», arresto senza ripartenza della coda. Rete vietata nel sottoprocesso; provider e API Telegram simulati.
- Telegram live, soltanto lettura: `getMe`, `getChat`, `getChatMember` riusciti. Gruppo con argomenti, bot amministratore con permessi di fissare messaggi e gestire argomenti.
- Configurazione live verificata senza esporre segreti: limite quattro esecuzioni, radice allegati `/home/djtupaka/telegram-inbox`, listener eventi non configurato.

I cicli RED/GREEN hanno coperto i nuovi moduli e regressioni concrete: invio al topic corretto, isolamento delle approvazioni, tre sottoscrizioni servite con concorrenza due, target revocati, abort prima/durante SDK e CLI, cleanup di una vecchia run che non ferma la nuova, pin fallito senza messaggi duplicati, coda non riavviata durante shutdown, confini dei giorni da 23/25 ore e verifiche del riavvio differito.

La review indipendente ha portato alla correzione della coda manuale durante automazioni, dei pulsanti del piano automatico, degli invii verso destinazioni revocate, della cancellazione durante l'avvio, del fallback Astra per sessioni automatiche e dell'arresto delle run obsolete. La review conclusiva non ha rilevato altri bloccanti.

## Backup

Archivio locale protetto:
`/home/djtupaka/projects/dev-bot/.data/backups/dev-group-20260914T094721Z.tar.gz`.

Contiene `state.json`, `topics.json`, `sessions.json`. Estratto in una directory temporanea: confronto byte per byte e parsing JSON riusciti per tutti e tre i file.

SHA-256: `3d5d6ffc227b508d17e2e1264827956dea37db83d63e2a9ca4beef287b90b5ac`.

Nessuna migrazione o cancellazione degli allegati storici, nessuna copia di credenziali nelle nuove guide o nei test.

## Attivazione e ricevuta

Questo bot usa `telegram-claude.service` di systemd, non Coolify. Il processo che prepara la modifica è figlio del bot attivo: un riavvio immediato interromperebbe la conversazione. Il coordinatore avvia quindi `scripts/restart-when-idle.ts` in un'unità systemd separata, dopo commit e push.

Lo script controlla PID atteso, commit, albero Git tracciato, backup e figli di tutti i thread; richiede due osservazioni senza figli a distanza di cinque secondi. Si ferma senza riavviare se cambiano le condizioni o scadono trenta minuti. Rimane una finestra non atomica tra l'ultimo controllo e il comando systemd: non è un blocco interno del bot.

Dopo un solo riavvio verifica nuovo PID, servizio attivo e marker di avvio della revisione nel journal. La ricevuta effettiva viene scritta in `.data/releases/<commit-completo>.json`. Il messaggio Telegram di avvio riporta la revisione caricata. L'esistenza del commit o la programmazione del riavvio **non** valgono come prova dell'attivazione: verificare quella ricevuta.

## Limiti di verifica e configurazione

Le approvazioni sono verificate sul contratto SDK locale e con callback simulate; non è stata avviata una sessione Claude reale di prova. I webhook nativi di Coolify/TrueNAS/Tdarr non sono stati configurati; è disponibile un ingresso normalizzato locale, disabilitato senza configurazione. Nessun programma live è stato creato per i test. Costi storici non ricostruiti: le statistiche iniziano con l'attivazione. Il piano preesistente `docs/superpowers/plans/2026-09-10-safe-astra-update.md` resta escluso dal commit.

## Aggiornamento: creazione progetto e scelta dalla lista

Richiesta successiva di Nicolas, 14 settembre 2026: creare la cartella Ubuntu per i nuovi progetti e poter aprire un argomento scegliendo un progetto esistente. Esplicitamente esclusi collegamenti per notifiche, già gestiti da altri bot.

Base `06af81efbae07e8888f17e3be1f957a533a7d35b`. Aggiunti pulsante Nuovo progetto e comando `/nuovo_progetto nome-progetto`; `/nuova` conserva la lista dei progetti esistenti e la scelta Claude/Codex. Creazione limitata a cartelle nuove direttamente sotto `PROJECTS_DIR`, senza sovrascrivere file, cartelle o collegamenti.

RED osservato nei test di creazione e nel vero handler `/nuova` isolato (pulsante mancante); GREEN dopo la modifica. Harness esteso a creazione della cartella, ricomparsa nella lista, collegamento dell'argomento, rifiuto di utenti/gruppi non autorizzati e callback con percorso esterno. Review indipendente senza bloccanti; corretta anche la segnalazione in italiano quando manca la radice configurata.

Verifica finale: `bun test` **270 pass, 0 fail**, 767 assertion, 40 file; `bun run typecheck`, `bun run lint` e `git diff --check` exit 0. I due avvisi di complessità del lint sono quelli già documentati. Nessun progetto o argomento live creato per i test.

Backup dello stato ripristinato e confrontato byte per byte:
`/home/djtupaka/projects/dev-bot/.data/backups/project-picker-20260914T100425Z.tar.gz`.
SHA-256 `18d774f77121903e9ddd1ca5bf53d2ac200ca7bd0c3fd6cd6b59bbf2dfd82bdf`.
Attivazione tramite lo stesso riavvio differito e ricevuta legata al nuovo commit, senza interrompere questa sessione.

## Aggiornamento: menu interattivo

Base `2cc740498daaa4df15a7891a70131818feb3e9a9`. Richiesta di Nicolas: menu, pulsanti e navigazione comoda fra progetti e impostazioni nel gruppo Dev. Realizzati menu inline distinti per Generale e argomento, collegamenti diretti agli argomenti del gruppo, attività in corso, impostazioni e azioni rapide che riusano i comandi esistenti. Il riepilogo fissato apre il menu in un nuovo messaggio; Generale offre il pulsante per fissare il menu. In privato resta la tastiera precedente con un tasto Menu aggiuntivo.

RED/GREEN sui menu mancanti, sull'integrazione `/menu` e sul collegamento dal riepilogo; test sui confini di gruppo, paginazione, operazioni vietate in Generale, isolamento delle impostazioni fra argomenti e conservazione delle tastiere di approvazione. Il dispatch dei pulsanti attraversa autenticazione e routing esistenti tramite un aggiornamento sintetico limitato ai comandi ammessi. Nessun evento esterno o collegamento ai servizi configurato.

Review indipendente senza difetti bloccanti. Limite UX dichiarato: Nuovo progetto mostra il comando per fornire il nome della cartella; non è un wizard di inserimento del nome.

Verifica finale: `bun test` **274 pass, 0 fail**, 790 assertion, 41 file; `bun run typecheck`, `bun run lint` e `git diff --check` exit 0. Lint con i due avvisi di complessità già presenti, nessun nuovo avviso. Prove Telegram e del routing in ambiente isolato senza rete; non è stata eseguita una prova manuale del client Telegram.

Backup con ripristino e confronto byte per byte di state/topics/sessions/operations:
`/home/djtupaka/projects/dev-bot/.data/backups/dev-menu-20260914T101701Z.tar.gz`.
SHA-256 `0f11315bcd81b0e86b7f402b11cfa9f8392835fda726027c8af973ba6924d64d`.
La precedente attivazione `2cc7404` ha ricevuta `success`. La nuova attivazione usa il riavvio differito e produce la propria ricevuta per commit in `.data/releases`.
