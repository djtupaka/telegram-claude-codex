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

## Aggiornamento: interfaccia italiana

Base `41cd8c81cfb85fbd856b6295e9bdcaa5c0dc077b`, attivazione precedente confermata dalla ricevuta `success`. Verificato con `getMyCommands` che i quattro ambiti registrati in Telegram contenevano ancora descrizioni inglesi; nessun elenco specifico `it` o `en` presente negli stessi ambiti. Tradotte tutte le descrizioni slash e le schermate richiamate dai menu, inclusi tastiera privata, guida, impostazioni, coda, composizione, cronologia e metadati. Nomi slash, callback, identificativi dei modelli, enum e prompt interni conservati. I messaggi originali prodotti dagli strumenti esterni conservano la lingua originale.

Harness isolato esteso al routing delle dieci etichette italiane e inglesi della tastiera: nessuna viene inviata come prompt all'AI. Review indipendente senza bloccanti; uniformati anche “ramo Git”, “richieste di modifica” e “argomento”.

Backup ripristinato e confrontato byte per byte:
`/home/djtupaka/projects/dev-bot/.data/backups/italian-ui-20260914T102633Z.tar.gz`.
SHA-256 `64e07ea3738810e8a459ad37a0a06cbb3608610f8b6383998c32217228b2ab4a`.

Verifica finale: `bun test` **274 pass, 0 fail**, 790 assertion, 41 file; typecheck e diff-check superati, lint senza errori con i due avvisi di complessità preesistenti. Nessun messaggio di prova o argomento creato su Telegram. Attivazione del codice tramite riavvio differito e ricevuta per commit; l'elenco slash può essere aggiornato e riletto separatamente senza interrompere le esecuzioni.

## Rimozione tastiera fissa

Richiesta successiva: lasciare libero lo spazio sotto il campo testo e usare il menu inline. Base `716b892c2f143fbf8f3f89696b73a61e489daa2a`. Tutte le risposte che ricreavano la tastiera ora ne chiedono la rimozione; anche il messaggio di avvio elimina la tastiera privata già visualizzata. Menu inline e alias dei vecchi pulsanti conservati.

RED osservato nell'harness sulla rimozione della tastiera in `/status`; GREEN dopo la correzione. Suite completa: 274 pass, 0 fail; typecheck e diff-check superati; lint con soli due avvisi di complessità preesistenti. Review indipendente senza problemi concreti.

Backup ripristinato e confrontato byte per byte: `/home/djtupaka/projects/dev-bot/.data/backups/keyboard-removal-20260914T103301Z.tar.gz`. SHA-256 `6a6bc4357624c43e88114f2c38ab8685836aafbf871156e09346d9331c69c0cc`. Attivazione differita al termine delle esecuzioni, con ricevuta per il nuovo commit.

## Installazione guidata e diagnostica

Base `0d63783ec301b16df77ccf31b4588652a0e9945c`. Implementati `bun run setup` interattivo e `bun run doctor`; aggiunti `/diagnostica` e pulsante nei menu privato, argomento e Generale. Il wizard conserva setup automatizzato e simulazione, protegge token/chiave vocale, conferma la creazione, non sovrascrive `.env` e valida gruppi negativi. Non cambia gli accessi o i dati dell'installazione corrente.

RED/GREEN per validazione gruppi, wizard e azione menu. Harness isolato verifica che utenti/gruppi non autorizzati non possano eseguire diagnostica e che pulsanti in Generale/argomento rispondano nel contesto giusto senza chiamare AI. Test PTY dell'implementer: segreti non visibili e annullamento senza scrittura. Review indipendente completata; corretto il caso Groq non dichiarato: il runtime richiede la variabile, mentre il valore vuoto disabilita i vocali. La diagnostica distingue formato locale da validità remota e presenza CLI da autenticazione.

Copia pulita in `/tmp/dev-bot-fresh-install-94roqzjq`: dipendenze installate con lockfile, configurazione fittizia creata con permessi `0600`, doctor e typecheck superati con HOME separata. Nessuna copia di `.env`, `.data` o credenziali personali; nessun avvio bot o accesso remoto effettuato. Le CLI già installate nell'host sono visibili tramite PATH: questa prova non equivale a installarle su un server vuoto.

Verifica finale: `bun test` **286 pass, 0 fail**, 845 assertion, 43 file. Typecheck, lint e diff-check superati; soltanto i due avvisi di complessità preesistenti. Backup ripristinato e confrontato byte per byte: `/home/djtupaka/projects/dev-bot/.data/backups/setup-doctor-20260914T104908Z.tar.gz`, SHA-256 `cabaaea9bdc4dcb457b10dfdeccf00d0c8d3d61dfa3ac86b4c7ac82999ce2251`. Rilascio tramite push main e riavvio differito con ricevuta del commit; non è un deploy Coolify.

## Nuovo progetto guidato

Base `9c12365111c1dac226b6c12ff2e8809d7703db71`, attivazione precedente confermata dalla ricevuta success. Il pulsante Nuovo progetto e il comando senza nome avviano la richiesta del nome tramite ForceReply e la scelta Claude/Codex. Cartella e argomento vengono creati soltanto dopo la scelta; la scorciatoia con nome conserva il comportamento precedente. Stato temporaneo separato per utente/gruppo/argomento, scadenza dieci minuti, nonce per i pulsanti, annullamento senza cartelle e consumo prima della creazione per impedire doppio clic.

RED osservato nell'harness reale isolato sul ForceReply mancante; GREEN dopo l'implementazione. Test su nomi invalidi, risposte fuori contesto, callback vecchie/duplicate, annullamento, scadenza e recupero dopo errore. Le risposte ai vecchi prompt del bot vengono riconosciute anche senza stato, evitando di inviare il nome come richiesta AI.

Review indipendente: corretto il contesto del pulsante dal menu principale, che deve conservare il callback originale invece di simulare una risposta a un messaggio del bot. Harness esteso al percorso effettivo del menu. Suite completa: **290 pass, 0 fail**, 865 assertion, 44 file. Nessuna cartella progetto o argomento Telegram live creato per queste prove; il comportamento visivo nel client Telegram non è stato verificato manualmente.

Backup con ripristino e confronto byte per byte: `/home/djtupaka/projects/dev-bot/.data/backups/project-wizard-20260914T105815Z.tar.gz`. SHA-256 `3f8b1751d368e262ffa913a2fe4f0093696ac73273786226c4f9b35475bc21ff`. Attivazione mediante riavvio differito e ricevuta per commit.

Typecheck, lint e diff-check finali superati; restano soltanto i due avvisi di complessità preesistenti.

## Pannelli operativi, allegati per progetto e timeout

Base `66660ed6a0e6767455a725b78acf7da7c0145b0f`. Aggiunti pannello `/lavori` con coda e tempi nel solo gruppo corrente, `/preferenze` per le nuove conversazioni e `/timeout` con limite disattivabile o personalizzato da 1 a 1440 minuti. Il limite viene passato al registro delle esecuzioni e conservato per conversazione; le esecuzioni già avviate mantengono quello iniziale.

I nuovi allegati vanno in `<progetto>/telegram/<conversazione>/<data>/`, esclusi dai commit con `.gitignore` interno. `/allegati` consulta insieme questa cartella e l’archivio precedente senza migrazioni storiche. Archiviazione e ripristino sono reversibili; la liberazione dello spazio richiede selezione, conferma personale e backup verificato su un filesystem separato. Nessun allegato live è stato spostato o eliminato e nessun volume backup operativo è stato scelto automaticamente.

RED/GREEN delle funzionalità verificato nei test mirati. Review indipendente del flusso: corretta l’interdizione degli allegati durante lavori di un progetto diverso. L’harness isolato prova i comandi reali del bot, il passaggio del timeout al runner, le preferenze, i due archivi e l’archiviazione mentre un altro progetto lavora; Telegram e agenti sono simulati e i dati sono temporanei.

Backup locale di rilascio ripristinato in una directory isolata e confrontato byte per byte: `.data/backups/complete-menu-20260914T112221Z.tar.gz`, SHA-256 `ed3147c407e6520eea0e0a7062a0ef149c6cbb075eaabb881056b3b63fe17092`. Attivazione prevista tramite servizio systemd differito al termine delle esecuzioni, con ricevuta per commit; non si tratta di un deploy Coolify.

Aggiornamenti protetti: CLI con controlli in checkout/HOME temporanei, backup limitato e verificato di configurazione/stato, verifica del servizio e ricevute. Review indipendente conclusa senza bloccanti dopo le correzioni a ExecStart, isolamento dell’ambiente, dimensione del backup e selezione della ricevuta di rollback. Il test con repository Git temporanei riproduce un secondo aggiornamento fallito prima del merge e verifica che il rollback precedente rimanga disponibile senza sostituire lo stato recente. Nessun aggiornamento o rollback live eseguito durante i test.

Cancello finale: `bun test` **317 pass, 0 fail**, 1015 asserzioni in 51 file; `bun run typecheck`, `bun run lint` e `git diff --check` superati. Il lint riporta soltanto i due avvisi di complessità preesistenti. Non è stata eseguita una prova manuale dell’interfaccia nel client Telegram.

## Eliminazione definitiva e distribuzione ZIP

Eliminazione disponibile per allegati attivi o archiviati, senza backup obbligatorio, con anteprima e conferma personale. Conservati controllo di integrità, percorso, scadenza, contesto e attività nel progetto. Nessun allegato operativo eliminato durante l’intervento. RED: tre test falliti sul vincolo precedente; GREEN: otto test mirati passati. Review indipendente senza bloccanti.

Verifica finale: 317 test passati, zero fallimenti, 1022 asserzioni; typecheck, lint e diff-check superati con i due avvisi di complessità preesistenti. Distribuzione con sorgenti, test, licenza MIT e guide generiche in italiano: esclusi dati, credenziali, cronologia Git, dossier e tooling locale Superpowers. Nella copia pulita installazione frozen-lockfile riuscita, 299 test passati, 981 asserzioni, typecheck e lint superati. Setup con configurazione fittizia e doctor verificati: la prima prova doctor ha correttamente rifiutato il token fittizio troppo corto; usando il formato valido la diagnostica è verde. Nessuna autenticazione remota o chiamata AI reale nella copia distribuita.
