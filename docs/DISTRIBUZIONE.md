# Dev Bot — guida rapida

Bot Telegram per lavorare sui propri progetti con Claude Code e Codex, in chat privata o in un gruppo con argomenti. Interfaccia operativa in italiano, menu interattivi, sessioni separate, coda, automazioni, allegati e impostazioni per conversazione.

## Requisiti

Ubuntu/Linux, Git, Bun e almeno uno degli assistenti supportati con account e accesso già configurati. Per Codex usare `codex login`; per Claude Code completare l’accesso dalla sua CLI. Installare gli strumenti seguendo le istruzioni ufficiali dei rispettivi prodotti. Il servizio automatico incluso usa systemd utente; questo pacchetto non è una versione portable per Windows.

## Prima installazione

1. Estrarre lo ZIP in una cartella stabile e aprire un terminale nella cartella `dev-bot`.
2. Eseguire `bun install --frozen-lockfile`.
3. Creare il proprio bot con `@BotFather` su Telegram e recuperare il proprio ID utente numerico.
4. Eseguire `bun run setup`: inserire token, ID utente, directory dei progetti e, facoltativamente, gruppi autorizzati e chiave Groq per i vocali.
5. Eseguire `bun run doctor`, poi `bun run start`.
6. Aprire il bot in Telegram, usare `/start`, scegliere il progetto e l’assistente dal menu.

La configurazione è conservata localmente in `.env`; sessioni e impostazioni in `.data`. Il pacchetto non contiene configurazioni, allegati o credenziali già pronti. Se Husky segnala l’assenza di `.git` durante l’installazione dallo ZIP, riguarda soltanto gli hook di sviluppo: verificare comunque l’esito dell’installazione delle dipendenze.

## Gruppo con argomenti

Creare un gruppo Telegram con gli argomenti abilitati. Aggiungere il bot e concedergli i permessi necessari per gestire gli argomenti; per fissare il menu serve anche il permesso di fissare messaggi. Configurare l’ID del gruppo in `ALLOWED_CHAT_IDS` e riavviare il bot. L’utente deve corrispondere a `ALLOWED_USER_ID`: questa distribuzione è pensata per un proprietario autorizzato per installazione.

Usare `/menu` nel Generale. **Nuovo progetto** crea la cartella nella directory dei progetti e il relativo argomento; **Apri argomento** consente di scegliere un progetto già esistente. Ogni argomento mantiene la propria conversazione. I lavori possono procedere in parallelo entro `MAX_CONCURRENT_RUNS`; evitare richieste incompatibili sugli stessi file.

## Comandi utili

- `/menu`: navigazione e impostazioni senza tastiera fissa.
- `/lavori`: lavori attivi e messaggi in coda.
- `/stop`: interrompe il lavoro della conversazione.
- `/timeout 45`: durata massima di 45 minuti per le prossime esecuzioni; `/timeout off` disabilita il limite.
- `/preferenze`: salva assistente, modello e ragionamento per le nuove conversazioni del progetto.
- `/allegati`: consulta i file in `telegram/` nel progetto, archivia, ripristina o elimina definitivamente dopo conferma. L’eliminazione non crea backup.
- `/diagnostica`: controlli locali; `/help`: guida ai comandi disponibili.

## Avvio automatico

Dopo avere fermato l’avvio manuale con Ctrl+C, eseguire `bun run service:install`. Usare `bun run service:status` e `bun run service:logs` per verificarlo. Non avviare due processi con lo stesso token. Per installazioni distinte sullo stesso server usare utenti di sistema separati.

## Verifica e aggiornamenti

`bun test`, `bun run typecheck` e `bun run lint` eseguono le verifiche incluse. I test simulano Telegram e gli assistenti: il primo messaggio reale verifica i propri accessi e la rete.

Lo ZIP non contiene cronologia Git o un remoto configurato. I comandi di aggiornamento gestito richiedono un checkout Git sul branch `main` con upstream `origin/main` attendibile: nella copia estratta la diagnostica Git può risultare non disponibile, senza impedire il normale uso del bot. Per aggiornare da un nuovo ZIP, fermare il servizio dopo la conclusione dei lavori, conservare separatamente `.env`, `.data` e i progetti, sostituire il codice e reinstallare le dipendenze. Non sovrascrivere la configurazione con quella di un’altra installazione.

Consultare `docs/INSTALLAZIONE_IT.md`, `docs/GRUPPO_DEV.md`, `docs/ALLEGATI.md`, `docs/PREFERENZE_PROGETTO.md` e `docs/AGGIORNAMENTI.md` per i dettagli. Le integrazioni esterne sono facoltative. Le attività AI operano con i permessi dell’utente del servizio: usare un account di sistema dedicato per limitarne l’accesso.

## Licenza

Distribuito con licenza MIT, conservata nel file `LICENSE` con l’attribuzione originale. Le dipendenze e gli assistenti mantengono le rispettive licenze e condizioni. Account, accessi e abbonamenti non sono inclusi.
