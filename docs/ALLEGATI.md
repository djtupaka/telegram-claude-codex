# Gestione degli allegati

Il comando `/allegati` consulta gli originali ricevuti nel progetto attivo, anche da altri argomenti dello stesso progetto. `/allegati pompa` cerca nel nome originale. Nel Generale è necessario selezionare un progetto o aprirne l’argomento. L’elenco mostra sei allegati per pagina; un tocco apre nome, dimensione, tipo, data, origine e impronta SHA-256 registrata. Nessun file viene inviato automaticamente.

I conteggi riguardano gli originali con metadati validi, non lo spazio complessivo del filesystem: non comprendono metadati, file orfani o altri documenti. La scansione è limitata a 5.000 voci del solo progetto; raggiunto il limite, avvisa che risultati e conteggi sono parziali. I record corrotti, i percorsi non coerenti e i collegamenti simbolici vengono ignorati o bloccati. L’impronta dei contenuti viene verificata prima delle modifiche.

## Cartella visibile nel progetto

I nuovi allegati vengono salvati in `<progetto>/telegram/<scope>/<AAAA-MM-GG>/`, con originale e metadati affiancati. Non viene aggiunta una seconda cartella con il nome del progetto. La cartella `telegram/` rimane consultabile direttamente dal filesystem. Alla creazione viene aggiunto un `.gitignore` interno con `*`, per evitare commit accidentali degli allegati; il `.gitignore` del progetto non viene modificato e un file interno già presente viene conservato.

I file ricevuti con la disposizione precedente restano nei percorsi originali: nessuno spostamento o migrazione automatica. Il gestore unisce i risultati della cartella nuova e dell’archivio precedente configurato da `ATTACHMENTS_DIR`, `UPLOADS_DIR` o dal percorso predefinito. Le operazioni accettano soltanto file nei due percorsi autorizzati del progetto. I conteggi combinano entrambi gli archivi entro lo stesso limite di scansione.

## Archiviazione e ripristino

Dai dettagli, **Archivia…** e **Ripristina…** mostrano un’anteprima e richiedono conferma. L’archiviazione è logica: aggiunge un indicatore accanto all’originale, senza spostarlo o modificarlo. L’elenco distingue gli archiviati con 📦. I riferimenti delle sessioni continuano a funzionare. **Spazio liberato: zero byte**.

Le conferme sono personali, legate a chat, argomento e progetto, scadono dopo dieci minuti e vengono invalidate dopo l’operazione. Il gestore rifiuta una modifica se il contesto segnala un’attività in corso o se originale/metadati sono cambiati dall’anteprima. Gli originali oltre 100 MiB rimangono consultabili ma la modifica viene rifiutata per limitare la memoria usata dalla verifica.

## Eliminazione definitiva

Dai dettagli di qualsiasi allegato, attivo o archiviato, **Elimina definitivamente…** mostra il nome e la dimensione e richiede una conferma personale. Il bot elimina originale, metadati e indicatore di archiviazione senza creare né richiedere un backup. Il file non è più recuperabile dal bot e i riferimenti nelle vecchie conversazioni smettono di funzionare.

Annullare o aprire un’altra vista non elimina nulla. Le conferme scadono dopo dieci minuti e sono vincolate a utente, conversazione e progetto; un doppio clic non ripete l’operazione. Restano i controlli su percorso, integrità, anteprima aggiornata e attività in corso nel progetto. Non esistono cancellazioni massive o automatiche. Un errore durante la rimozione può lasciare metadati orfani da verificare manualmente.

## Verifica locale

`bun test src/attachment-manager.test.ts src/bot-attachments.test.ts` usa solo directory temporanee e verifica ricerca, isolamento, archiviazione, ripristino, eliminazione senza backup, anteprime obsolete, metadati ostili e conferme personali.
