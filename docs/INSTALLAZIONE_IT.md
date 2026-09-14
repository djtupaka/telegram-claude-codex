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

Dalla nuova copia del repository si può prima simulare la preparazione:

```bash
bun run scripts/setup.ts --dry-run
```

La simulazione mostra soltanto i percorsi e non scrive file. Per creare `.env`,
usare queste istruzioni Bash: il token viene letto senza mostrarlo e non viene
inserito nella cronologia dei comandi.

```bash
read -r -s -p 'Token del nuovo bot: ' SETUP_BOT_TOKEN
printf '\n'
export SETUP_BOT_TOKEN
read -r -p 'Il tuo ID utente Telegram numerico: ' SETUP_USER_ID
export SETUP_USER_ID
read -r -p 'Cartella assoluta dei progetti: ' SETUP_PROJECTS_DIR
export SETUP_PROJECTS_DIR
bun run scripts/setup.ts
unset SETUP_BOT_TOKEN SETUP_USER_ID SETUP_PROJECTS_DIR
```

Per abilitare i vocali, impostare anche `SETUP_GROQ_API_KEY` con `read -r -s`
prima del setup e rimuoverla dall'ambiente al termine. Si può anche aggiornare
manualmente il solo valore `GROQ_API_KEY` nel proprio `.env` in seguito.

Lo script crea `.env` con permessi `0600` e la cartella progetti se manca. Non
sovrascrive mai una configurazione esistente, nemmeno tramite collegamento
simbolico, e non avvia servizi. Per modificare un'installazione già configurata,
aprire il suo `.env` localmente. Non incollare il contenuto in chat, ticket o
commit. Il setup accetta variabili `SETUP_*` specifiche e non riutilizza
automaticamente i segreti di un `.env` preesistente.

## Avvio e verifica

```bash
bun run typecheck
bun test
bun run start
```

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

I nuovi allegati vengono conservati nell'archivio dati del bot, separati per
progetto, conversazione e giorno UTC. Ogni nome contiene un identificativo
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
