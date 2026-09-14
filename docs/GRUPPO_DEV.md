# Gruppo Dev: sessioni, allegati e automazioni

## Ambito approvato

Ripresa degli inoltri del 14 settembre 2026: lavori simultanei su progetti distinti, approvazioni Telegram, programmi, eventi dai servizi, notifiche di conclusione, statistiche, riepiloghi e installazione autonoma per amici. Nessuna modifica applicativa o ai dati commerciali di PremelOne.

## Lavori simultanei

Ogni argomento conserva progetto, provider, modello, impegno e conversazione propri. Nodarr e PremelOne possono lavorare contemporaneamente in argomenti separati. Il limite globale resta `MAX_CONCURRENT_RUNS=4` predefinito. Una quinta esecuzione viene rifiutata dal limite: non esiste una coda globale. Nello stesso argomento i messaggi si accodano, anche durante un programma automatico, e riprendono alla sua conclusione. Le sessioni separate non isolano i file: due lavori sullo stesso repository devono coordinarsi.

## Menu interattivo

Usare `/menu` nel gruppo o il tasto **Menu** in privato. `/start` nel gruppo apre lo stesso pannello.

- In **Generale**: progetti e argomenti già aperti, creazione di un argomento da un progetto esistente, nuovo progetto, attività in corso, aggiornamento e pulsante per fissare il menu.
- In un **argomento**: progetto, agente, modello, impegno e stato corrente; impostazioni, statistiche, cronologia, nuova conversazione, raccolta/invio dei messaggi e arresto del lavoro. Ogni azione riguarda la conversazione in cui viene premuta.
- **Impostazioni**: agente, modello, impegno e permessi. I tasti richiamano gli stessi comandi esistenti e conservano i loro controlli; in Generale le impostazioni di sessione non sono eseguibili.
- La lista degli argomenti è paginata e filtrata per gruppo. I pulsanti aprono direttamente l'argomento; Attività mostra solo quelli con un lavoro attivo.
- I riepiloghi fissati degli argomenti includono **Menu**, che apre un nuovo messaggio e conserva il riepilogo. Il menu di Generale si fissa con **Fissa menu**, senza rimuovere gli altri messaggi fissati.

I pulsanti di arresto e nuova conversazione eseguono i relativi comandi, incluso lo svuotamento della coda previsto dal bot. Il cambio agente interrompe l'esecuzione attiva; modello e impegno si applicano al messaggio successivo. Nuovo progetto mostra il comando con cui fornire il nome della cartella. Restano disponibili tutti i comandi testuali.

I link degli argomenti seguono il [formato ufficiale Telegram](https://core.telegram.org/api/links#forum-topic-links). Il menu usa pulsanti inline legati al messaggio; la tastiera privata viene sostituita da un collegamento Menu nelle risposte del gruppo. Nessun collegamento ai servizi esterni è stato aggiunto.

## Progetti nuovi ed esistenti

`/nuova` mostra le cartelle già presenti nella directory `PROJECTS_DIR` di Ubuntu. Scegliere un progetto e poi Claude o Codex crea un argomento collegato a quella cartella, senza ricreare il progetto.

Il pulsante **Nuovo progetto** spiega come usare `/nuovo_progetto nome-progetto`: il comando crea una cartella vuota direttamente sotto `PROJECTS_DIR` (nell'installazione di Nicolas `/home/djtupaka/projects`), poi propone l'agente per aprire l'argomento. Il nome deve contenere da 1 a 40 lettere, numeri, trattini o underscore e iniziare con una lettera o un numero. Cartelle, file e collegamenti già presenti non vengono sovrascritti. Non vengono inizializzati Git, template o servizi. Se si abbandona la scelta dell'agente, la cartella creata rimane disponibile nella lista di `/nuova`.

Creare manualmente un argomento dall'interfaccia Telegram non crea una cartella su Ubuntu: usare i comandi del bot per collegare le due cose.

## Comandi

| Comando | Risultato |
| --- | --- |
| `/nuova` | Sceglie un progetto esistente per aprire un argomento; offre anche Nuovo progetto. |
| `/nuovo_progetto nome-progetto` | Crea la cartella su Ubuntu e propone l’agente per il nuovo argomento. |
| `/permessi` | Mostra il criterio della conversazione. |
| `/permessi chiedi` | Con Claude, richiede un pulsante per **ogni** strumento; Codex resta bloccato. |
| `/permessi automatici` | Usa l'esecuzione automatica consueta. |
| `/stats` | Esiti, tempi e costi disponibili di oggi, Europe/Rome. |
| `/stats AAAA-MM-GG` | Statistiche di un giorno, rispettando l'ora legale. |
| `/stats tutto` | Storico registrato per la conversazione. |
| `/riepilogo` | Aggiorna il messaggio fissato nell'argomento. |
| `/programma giornaliero HH:MM testo` | Programma giornaliero, Europe/Rome. |
| `/programma una ISO testo` | Esecuzione singola; data futura con fuso, ad esempio `2026-12-01T10:00:00+01:00`. |
| `/programmi` | Elenco, identificativi e stato dei programmi della conversazione. |
| `/annulla_programma ID` | Annulla il programma della conversazione e interrompe la sua esecuzione. |
| `/eventi coolify on` | Sottoscrive la sorgente; disponibili anche `truenas`, `tdarr`, `off`, `stato`. |

I permessi non cambiano durante una run. Le approvazioni sono monouso, legate a utente/chat/argomento/esecuzione, e scadono dopo due minuti. Il riavvio le invalida. Input troppo lunghi non possono essere approvati con contenuto nascosto. Non viene promessa una classificazione automatica dei comandi “pericolosi”. Le policy enterprise che disabilitano gli hook SDK richiedono una verifica dedicata prima dell'uso di questa modalità.

Il riepilogo mostra progetto, branch, provider, modello, impegno, permessi e stato; richiede al bot il diritto di fissare messaggi. Non rimuove gli altri messaggi fissati. Per run superiori a due minuti viene pubblicato un avviso in Generale. “Esecuzione terminata” indica la fine della run, non una certificazione che l'attività richiesta sia riuscita.

Le statistiche partono dall'attivazione della funzione. I costi non dichiarati dal provider rimangono sconosciuti, non diventano zero. I valori dichiarati dal provider non equivalgono necessariamente all'addebito dell'abbonamento.

## Allegati

I nuovi documenti, foto e vocali vengono conservati in:

```
<radice>/<progetto-hash>/<conversazione-hash>/<AAAA-MM-GG UTC>/<uuid>-<nome sicuro>
```

La radice è `ATTACHMENTS_DIR`, in alternativa il precedente `UPLOADS_DIR`, altrimenti `.data/attachments` del bot. Ogni file ha un manifest JSON affiancato con nome originale, progetto, conversazione, provenienza Telegram, MIME, dimensione e SHA-256. Nuovi file e manifest hanno permessi `0600`; le nuove directory `0700`. I nomi uguali non sovrascrivono allegati precedenti. Non vengono spostati o cancellati gli archivi preesistenti.

Lo script di invio conserva il nome del documento. Nei gruppi richiede sia un gruppo autorizzato sia l'identificativo di un argomento registrato (`--thread`), e conserva in `.data/deliveries` una ricevuta con SHA-256 e identificativo del messaggio. Un errore nella ricevuta dopo l'invio viene segnalato senza suggerire un reinvio automatico. I file vengono inviati soltanto su richiesta esplicita dell'utente.

## Automazioni ed eventi

**Decisione di Nicolas del 14 settembre 2026:** non configurare collegamenti per notifiche di Coolify, TrueNAS, Tdarr o altri servizi; sono già gestiti da altri bot. La predisposizione tecnica sotto descritta non costituisce un'attività pendente né autorizza l'attivazione di webhook.

Un programma conserva progetto/provider/modello/impegno scelti al momento della creazione; i permessi vengono rivalutati all'esecuzione. Se un argomento è stato rimosso, il gruppo non è più autorizzato o il progetto è cambiato, il programma non parte. Le automazioni non riprendono né sostituiscono la sessione manuale. Un piano prodotto automaticamente viene segnalato senza pulsanti che possano eseguire un vecchio piano manuale.

Il ricevitore HTTP è **disabilitato** finché non vengono configurati `EVENTS_PORT` e `EVENTS_TOKEN` (almeno 32 caratteri). Ascolta esclusivamente su `127.0.0.1`. Le sottoscrizioni Telegram non configurano automaticamente i webhook nei servizi esterni. Il formato normalizzato e le garanzie di esecuzione sono descritti in [AUTOMATIONS_API.md](AUTOMATIONS_API.md). Servono adattatori o configurazioni sul mittente per i payload nativi dei singoli servizi.

Il payload di un evento è un dato non attendibile: con Claude la diagnosi usa solo Read/Glob/Grep e non modifica file né esegue comandi; con Codex viene pubblicata soltanto la notifica. Non vengono compiute riparazioni automatiche a partire dal testo ricevuto. Non sono stati creati programmi o webhook live a scopo di test.

## Installazione indipendente

Seguire [INSTALLAZIONE_IT.md](INSTALLAZIONE_IT.md). L'amico usa il proprio server, bot, account e credenziali. Il setup non copia `.env`, sessioni o allegati di questa installazione.

## Verifica e attivazione

I test usano provider e Telegram simulati, directory temporanee e nessuna modifica ai progetti operativi. Il test d'integrazione esercita i veri handler del bot in un sottoprocesso isolato senza rete. Prima dell'attivazione: suite completa, typecheck, lint e diff-check; backup dello stato. Il bot è un servizio systemd, non una risorsa Coolify. Non riavviare mentre esistono esecuzioni attive: anche l'agente che prepara l'aggiornamento è un processo figlio del bot. Il messaggio di avvio mostra la revisione Git caricata.

## Lingua dei comandi e dei menu

Le descrizioni dell'elenco che Telegram mostra digitando `/` sono in italiano, sia in privato sia nei gruppi. I nomi dei comandi restano invariati per conservare le scorciatoie esistenti. Anche i pulsanti, la guida, le impostazioni e i messaggi di servizio usano l'italiano; i nomi dei prodotti e gli identificativi dei modelli restano quelli originali. I vecchi pulsanti in inglese già presenti nella chat continuano a essere riconosciuti.

Per aprire la navigazione usa `/menu`; per consultare tutti i comandi usa `/help`. I messaggi già inviati rimangono nella cronologia con il testo originale.
