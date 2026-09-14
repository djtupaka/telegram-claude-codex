# Gestione degli allegati

Il comando `/allegati` consulta gli originali ricevuti nel progetto attivo, anche da altri argomenti dello stesso progetto. `/allegati pompa` cerca nel nome originale. Nel Generale è necessario selezionare un progetto o aprirne l’argomento. L’elenco mostra sei allegati per pagina; un tocco apre nome, dimensione, tipo, data, origine e impronta SHA-256 registrata. Nessun file viene inviato automaticamente.

I conteggi riguardano gli originali con metadati validi, non lo spazio complessivo del filesystem: non comprendono metadati, file orfani o altri documenti. La scansione è limitata a 5.000 voci del solo progetto; raggiunto il limite, avvisa che risultati e conteggi sono parziali. I record corrotti, i percorsi non coerenti e i collegamenti simbolici vengono ignorati o bloccati. L’impronta dei contenuti viene verificata prima delle modifiche.

## Cartella visibile nel progetto

I nuovi allegati vengono salvati in `<progetto>/telegram/<scope>/<AAAA-MM-GG>/`, con originale e metadati affiancati. Non viene aggiunta una seconda cartella con il nome del progetto. La cartella `telegram/` rimane consultabile direttamente dal filesystem. Alla creazione viene aggiunto un `.gitignore` interno con `*`, per evitare commit accidentali degli allegati; il `.gitignore` del progetto non viene modificato e un file interno già presente viene conservato.

I file ricevuti con la disposizione precedente restano nei percorsi originali: nessuno spostamento o migrazione automatica. Il gestore unisce i risultati della cartella nuova e dell’archivio precedente configurato da `ATTACHMENTS_DIR`, `UPLOADS_DIR` o dal percorso predefinito. Le operazioni accettano soltanto file nei due percorsi autorizzati del progetto. I conteggi combinano entrambi gli archivi entro lo stesso limite di scansione.

## Archiviazione e ripristino

Dai dettagli, **Archivia…** e **Ripristina…** mostrano un’anteprima e richiedono conferma. L’archiviazione è logica: aggiunge un indicatore accanto all’originale, senza spostarlo o modificarlo. L’elenco distingue gli archiviati con 📦. I riferimenti delle sessioni continuano a funzionare. **Spazio liberato: zero byte**.

Le conferme sono personali, legate a chat, argomento e progetto, scadono dopo dieci minuti e vengono invalidate dopo l’operazione. Il gestore rifiuta una modifica se il contesto segnala un’attività in corso o se originale/metadati sono cambiati dall’anteprima. Gli originali oltre 100 MiB rimangono consultabili ma la modifica viene rifiutata per limitare la memoria usata dalla verifica.

## Liberare spazio sul volume degli originali

Per abilitare **Libera spazio…**, configurare `ATTACHMENTS_BACKUP_DIR` come directory già esistente su un filesystem separato. Il percorso deve essere reale, senza collegamenti simbolici. Il confronto del dispositivo (`st_dev`) impedisce una copia sullo stesso filesystem; l’operatore deve assicurarsi che il volume sia persistente, affidabile e disponga di spazio. Non usare directory temporanee come destinazione operativa.

L’azione è disponibile soltanto per un allegato già archiviato. L’anteprima identifica nome e dimensione e avverte che i riferimenti nelle vecchie conversazioni smetteranno di funzionare. Dopo conferma viene creata una copia con nome univoco sul volume backup, insieme ai metadati originali. Il gestore rilegge e verifica impronta e metadati, ricontrolla l’originale e soltanto dopo elimina dal volume archivio il file originale, i metadati e l’indicatore di archiviazione.

La copia sul volume backup resta conservata: si libera spazio sul volume sorgente, non si riduce la somma dei contenuti sui due volumi. Il ripristino dopo questa operazione richiede un intervento manuale, usando il percorso originale registrato nei metadati; non esiste eliminazione automatica dei backup. Un errore prima della verifica preserva l’originale e può lasciare una copia parziale da controllare. Un errore durante la rimozione può lasciare metadati orfani, che la scansione successiva ignora.

Non sono previste cancellazioni massive, politiche automatiche per età o modifiche degli allegati storici senza selezione e conferma esplicita.

## Verifica locale

`bun test src/attachment-manager.test.ts src/bot-attachments.test.ts` usa directory temporanee; prova ricerca, isolamento dei progetti, archiviazione e ripristino, anteprime obsolete, metadati ostili, vincoli delle conferme e backup separato prima della rimozione. Il test del backup separato usa `/dev/shm` solo come fixture temporanea su Linux, mai come configurazione operativa.
