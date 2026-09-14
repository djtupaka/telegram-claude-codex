# Installazione personale del bot Telegram

Ogni amico deve usare una propria installazione, un proprio bot Telegram e il
proprio account del provider. Non copiare `.env`, `.data`, sessioni, credenziali o
allegati di un'altra persona. Il bot può eseguire strumenti e modificare file con
i permessi dell'utente che lo avvia: usare un account di sistema dedicato quando
la macchina è condivisa.

## Preparazione

1. Installare Git, Bun e almeno una delle CLI supportate, Claude Code o Codex.
2. Clonare questo repository in una cartella personale ed eseguire `bun install`.
3. Creare un bot con `@BotFather` e conservare il token privatamente.
4. Recuperare il proprio ID utente Telegram numerico e scegliere una cartella
   assoluta per i progetti.
5. Accedere al provider dal medesimo utente di sistema che avvierà il bot:
   `codex login` oppure avviare `claude` e completare l'accesso.

Il login del provider e l'accesso Telegram sono separati. Una chiave Groq è
opzionale e serve per trascrivere messaggi vocali.

## Configurazione guidata da terminale

Dalla nuova copia del repository:

```bash
bun run setup
```

La procedura chiede token Telegram, ID utente, cartella assoluta dei progetti,
chiave Groq facoltativa e ID dei gruppi facoltativi. Token e chiave Groq non
vengono mostrati sul terminale né stampati nel riepilogo. Gli ID dei gruppi devono
essere interi negativi separati da virgole, per esempio `-1001234567890`.
Invio sulla cartella propone `~/projects`; sui campi facoltativi li lascia vuoti.

Prima di scrivere viene chiesta conferma. Rispondere `s` per procedere oppure
premere Invio per annullare; `Ctrl+C` e `Ctrl+D` annullano anche durante le domande.
L'annullamento non scrive file. Per provare le domande senza salvare:

```bash
bun run setup --dry-run
```

Per automazioni resta disponibile la modalità non interattiva:
`bun run scripts/setup.ts`. Richiede `SETUP_BOT_TOKEN` e `SETUP_USER_ID`;
accetta `SETUP_PROJECTS_DIR` (predefinito `~/projects`), `SETUP_GROQ_API_KEY` e
`SETUP_ALLOWED_CHAT_IDS`. Passare i segreti tramite un ambiente protetto, senza
scriverli nella cronologia dei comandi. `bun run scripts/setup.ts --dry-run`
mostra i percorsi senza scrivere e usa valori fittizi se token e ID non sono
presenti. La modalità interattiva richiede un terminale e chiede sempre nuovi
valori, senza usare credenziali già presenti nell'ambiente.

Lo script crea `.env` con permessi `0600` e la cartella progetti se manca. Non
sovrascrive mai una configurazione esistente, nemmeno tramite collegamento
simbolico, e non avvia servizi. Per modificare un'installazione già configurata,
aprire il suo `.env` localmente. Non incollare il contenuto in chat, ticket o
commit. Il setup accetta variabili `SETUP_*` specifiche e non riutilizza
automaticamente i segreti di un `.env` preesistente.

## Avvio e verifica

```bash
bun run doctor
bun run start
```

`doctor` controlla la configurazione e i prerequisiti locali. La presenza di una
CLI non conferma l'accesso all'account: completare il login separatamente.
Il provider iniziale è Claude; se si vuole usare soltanto Codex, selezionarlo con
`/provider` prima del primo messaggio operativo. Dopo l'avvio, `/diagnostica`
permette di consultare i controlli dal bot senza mostrare i segreti.

Aprire in privato il nuovo bot, inviare `/start`, selezionare un progetto con
`/projects` e provare un messaggio testuale. Per creare il progetto, predisporre
una sottocartella nella cartella progetti scelta. Dopo aver verificato il
funzionamento, su Linux si può usare `bun run service:install` per il servizio
utente. L'unità di servizio ha un nome condiviso fra copie del repository:
installazioni diverse sulla stessa macchina devono usare utenti di sistema
diversi per non sostituire il servizio di un'altra copia.

Per i gruppi con argomenti configurare esplicitamente `ALLOWED_CHAT_IDS` nel
proprio `.env`; l'autorizzazione dell'utente rimane distinta da quella del gruppo.
Non condividere lo stesso token fra due processi che ricevono gli aggiornamenti.

## Allegati e backup

I nuovi allegati vengono conservati nella cartella `telegram` del progetto,
separati per conversazione e giorno UTC. Gli originali precedenti rimangono
consultabili nell’archivio centrale senza migrazione automatica. Ogni nome contiene un identificativo
univoco e una versione sicura del nome originale. Il file originale conserva
esattamente i byte ricevuti; un manifest affiancato (`.metadata.json`) contiene
nome originale, tipo MIME dichiarato da Telegram, identificativi Telegram,
progetto, conversazione, data, dimensione, hash SHA-256 e percorso.

Cartelle e manifest permettono di ritrovare l'origine del file senza mescolare
conversazioni o modificare i repository dei progetti. Gli identificativi dei
percorsi includono un hash per distinguere nomi simili. Non viene eseguita alcuna
migrazione o eliminazione degli allegati storici. Non è prevista una scadenza
automatica: monitorare lo spazio e includere l'archivio nei backup personali.

I backup devono conservare `.env` separatamente e in modo protetto, oltre ai
dati del bot e ai propri progetti. I manifest contengono percorsi assoluti: in
caso di ripristino su un'altra macchina mantenere i percorsi oppure considerare
quelli registrati come provenienza della vecchia installazione.

Per gli aggiornamenti protetti e il ritorno alla versione precedente consultare [AGGIORNAMENTI.md](AGGIORNAMENTI.md). La gestione dello spazio e del backup degli allegati è descritta in [ALLEGATI.md](ALLEGATI.md).
