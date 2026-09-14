# Aggiornamenti protetti e ritorno alla versione precedente

Eseguire i comandi da un terminale esterno al bot, nella cartella del repository.
La voce Telegram `/aggiornamenti` mostra lo stato; non aggiorna né riavvia.

```bash
bun run scripts/managed-update.ts status
bun run scripts/managed-update.ts check
```

`status` legge soltanto il commit nel checkout e l'ultima ricevuta locale: non
interroga la rete e non prova che quel commit sia già in esecuzione. `check`
aggiorna il riferimento Git `origin/main` tramite fetch e verifica che sia un
avanzamento possibile; non modifica il checkout e non esegue test.

## Applicazione

Attendere la conclusione delle sessioni in **tutti** gli argomenti e nelle chat private.
Verificare lo stato del bot, poi arrestare il servizio dal terminale esterno.
Il comando di arresto può interrompere sessioni ancora attive: non lanciarlo da
una sessione gestita dal bot stesso.

```bash
bun run service:stop
bun run scripts/managed-update.ts apply
```

L'aggiornamento richiede il branch `main`, upstream `origin/main`, indice e file
tracciati puliti, servizio completamente arrestato e configurato per lo stesso
checkout e runtime Bun. Non avviare manualmente il servizio e non modificare il
repository mentre il comando lavora. I file non tracciati restano presenti; Git
rifiuta le collisioni con file non ignorati. Le destinazioni che tracciano `.env`
o `.data` vengono rifiutate.

Il comando seleziona l'attuale `origin/main`, crea un worktree temporaneo ed
esegue installazione con lockfile congelato, test, typecheck e lint. I controlli
usano una HOME temporanea e un ambiente limitato a HOME, PATH, LANG, HUSKY e CI:
non ricevono token o credenziali del processo chiamante. Questo è isolamento di
configurazione, non una sandbox del filesystem o della rete: il codice remoto
selezionato deve essere attendibile.

Dopo i controlli crea e verifica il backup, ricontrolla servizio e checkout,
applica esclusivamente un fast-forward e reinstalla le dipendenze dal lockfile.
Avvia il servizio e considera concluso l'aggiornamento soltanto quando trova nel
journal il messaggio di avvio della revisione attesa associato al nuovo PID.
L'operazione non esegue commit, push o deploy di altri progetti.

## Backup e ricevute

La directory privata `~/.local/state/dev-bot-updates/<identificativo-checkout>/`
contiene backup JSON e ricevute. Directory: permessi `0700`; file: `0600`.
Il backup comprende **`.env` e i soli file `.data/*.json` direttamente nella
cartella**, come stato, sessioni, argomenti e operazioni. Il limite complessivo è
32 MiB: se superato l'aggiornamento si ferma prima di modificare il codice.
Link simbolici e file speciali inclusi nella selezione vengono rifiutati.

Sono esclusi log JSONL, sottocartelle, backup precedenti, allegati e relativi
metadati esterni, cronologie dei provider, progetti e configurazioni del sistema.
Gli archivi allegati richiedono il proprio backup dedicato. L'aggiornamento e il
rollback non eliminano né ripristinano questi archivi.

Ogni backup viene riletto e ripristinato in una directory temporanea protetta;
nomi e SHA-256 sono confrontati con gli originali, poi la copia di verifica è
rimossa. Il file contiene segreti in base64, **non cifrati**: conservarlo come
una credenziale. Contenuti e output dei subprocessi non vengono stampati.
Le ricevute riportano commit precedente/destinazione, controlli, backup,
operazione, stato, data e PID. Lo storico mantiene il riferimento per tornare
indietro anche se un aggiornamento successivo fallisce prima della modifica Git.

## Ritorno alla versione precedente

Dopo aver concluso le sessioni e arrestato il servizio:

```bash
bun run scripts/managed-update.ts rollback
```

Viene selezionata la ricevuta più recente compatibile con il commit corrente,
compresa quella di un'installazione interrotta dopo il cambio del codice. Il
comando verifica la versione precedente in isolamento, crea un nuovo backup e
riporta `main` al commit precedente con `git reset --keep`, che conserva le
modifiche locali incompatibili rifiutando l'operazione. Reinstalla le dipendenze
e verifica l'avvio. Non usa `reset --hard`.

Il rollback riguarda **codice e dipendenze**: conserva lo stato attuale, incluse
le sessioni nate dopo l'aggiornamento. Non ripristina automaticamente `.env` o
JSON precedenti e non garantisce compatibilità con future migrazioni del formato
di stato; una versione che richiede una migrazione deve prevedere una procedura
dedicata. L'eventuale ripristino dei dati da backup è un intervento separato da
valutare esplicitamente per evitare di perdere dati più recenti.

## Interruzioni e recupero

Se un controllo preliminare fallisce, il codice resta invariato e il servizio
resta arrestato: correggere la causa oppure avviarlo con `bun run service:start`.
Dopo la modifica Git un errore può lasciare il codice aggiornato con dipendenze
incomplete; non avviare alla cieca. Leggere `status`, controllare il commit e
usare `rollback` con servizio arrestato. Un errore nella conferma di avvio può
lasciare il servizio attivo: consultare `service:status` e `service:logs`, poi
concludere eventuali sessioni prima di arrestarlo per il recupero.

Un lock impedisce aggiornamenti concorrenti. Dopo un'interruzione forzata può
rimanere la sottocartella `lock`: rimuoverla soltanto dopo aver verificato che
nessun processo `managed-update.ts` sia ancora in esecuzione. Se la pulizia del
worktree temporaneo fallisce viene mostrato il percorso, da controllare con
`git worktree list` prima della rimozione manuale. Non cancellare backup o
ricevute per sbloccare un aggiornamento.
