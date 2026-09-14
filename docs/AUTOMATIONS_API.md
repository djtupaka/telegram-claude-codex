# Programmi e notifiche: contratto dei moduli

`src/automations.ts` e `src/event-ingress.ts` non avviano servizi e non creano programmi alla loro importazione. L'integrazione Telegram autorizza e risolve il topic prima di chiamare lo store.

## Programmi

`makeAutomationStore(path?)` conserva atomicamente `.data/automations.json`. `add(input, now?)` richiede `scopeKey`, `chatId`, eventuale `threadId`, `project`, `provider`, eventuali `model`/`effort`, `prompt` e `schedule`. Progetto, provider e destinazione sono fissati alla creazione; una successiva selezione nel topic non li modifica.

- `{ kind: "daily", time: "09:00", timezone: "Europe/Rome" }`: giornaliero, fuso predefinito Europe/Rome; l'ora inesistente al passaggio all'ora legale viene saltata e l'ora ripetuta in autunno viene eseguita una sola volta.
- `{ kind: "once", at: "2026-12-01T09:00:00+01:00" }`: esecuzione singola futura; indicare esplicitamente il fuso nell'ISO.

`list(scopeKey?)`, `cancel(scopeKey, id)`, `subscribe(target & {source})`, `subscriptions(source?)` e `unsubscribe(scopeKey, source)` sono le operazioni disponibili. Le sorgenti ammesse sono `coolify`, `truenas` e `tdarr`. Le sottoscrizioni conservano lo stesso contesto dei programmi.

`makeAutomationScheduler({store, run, isBusy?, onError?, timeoutMs?, maxConcurrent?})` espone `tick(now?)`, `start()` e `stop()`. Il controllo periodico avviene ogni 15 secondi, con due esecuzioni simultanee al massimo per impostazione predefinita. Lo scope occupato viene rimandato, mantenendo una sola scadenza arretrata. `run(job, signal)` deve rispettare l'annullamento e rifiutare la promessa in caso di errore. Il timeout predefinito è dieci minuti: invia l'abort e mantiene occupato lo slot fino alla conclusione dell'adapter, evitando sovrapposizioni se questo tarda a terminare.

La scadenza successiva viene salvata prima dell'avvio: dopo un arresto imprevisto il lavoro non viene ripetuto automaticamente. Un'esecuzione interrotta dal processo può rimanere nello stato `running`, da controllare manualmente. `lastResult`, `lastError` e `lastRunAt` consentono di mostrare l'esito; i programmi singoli conclusi restano consultabili fino alla cancellazione.

## Ricezione eventi

`makeEventIngress({token, store, diagnose, isBusy?, onError?, maxConcurrent?, timeoutMs?, dedupTtlMs?})` espone `fetch(Request)` e `close()`. Il chiamante può collegarlo a `Bun.serve`, con `hostname: "127.0.0.1"`, `maxRequestBodySize: 32768` e un `idleTimeout` breve. L'abilitazione del listener deve essere esplicita, con porta configurata e token esterno al repository. L'eventuale esposizione tramite proxy richiede una configurazione dedicata.

Il formato è un evento normalizzato; i payload nativi dei fornitori richiedono un adapter:

```json
{
  "id": "deployment-123",
  "source": "coolify",
  "title": "Deploy fallito",
  "message": "Descrizione dell'errore",
  "severity": "error"
}
```

Inviare `POST /events`, `Content-Type: application/json` e `Authorization: Bearer <token>`. `severity` è facoltativa (`info`, `warning`, `error`). Il corpo è limitato a 32 KiB anche senza Content-Length. La risposta è `202` per l'accettazione, `200` per un duplicato, `404` se manca una sottoscrizione, `429` quando le diagnosi sono occupate. In caso di `429` il mittente può riprovare lo stesso ID. Gli ID sono deduplicati per sorgente in memoria per 24 ore, fino a 10.000 elementi; la deduplicazione si azzera al riavvio. `202` conferma l'accettazione, non il completamento della diagnosi.

`diagnose(subscription, prompt, signal)` deve applicare una modalità di sola lettura effettiva a livello di strumenti o sandbox. Il prompt etichetta il payload come dati esterni non attendibili, ma il testo da solo non costituisce una protezione. Il contenuto di una notifica non autorizza scritture, deploy, riavvii o modifiche alla produzione. L'adapter può limitarsi alla notifica se il provider non supporta un isolamento di sola lettura adeguato.

Gli errori sono inoltrati a `onError`. Non è previsto un tentativo automatico dopo un errore della diagnosi; ogni intervento successivo richiede una richiesta dell'utente. Questi moduli non configurano webhook, job o servizi reali.

## Comandi Telegram

`installAutomations` in `src/bot-automations.ts` registra `/programma`, `/programmi`, `/annulla_programma` e `/eventi`. Riceve il bot, lo store facoltativo, `getTarget(ctx)`, `validateTarget(target)`, `run(target, prompt, signal, readOnly)`, `isBusy(scopeKey)` e l'eventuale configurazione `eventsPort`/`eventsToken`. `getTarget` deve rifiutare utenti e scope non autorizzati. L'installazione restituisce `start()` e `stop()` e non apre porte fino a `start()`.

Esempi di sintassi:

- `/programma giornaliero 09:00 Controlla lo stato dei backup`
- `/programma una 2026-12-01T09:00:00+01:00 Controlla il risultato della manutenzione`
- `/programmi`
- `/annulla_programma <id completo>`
- `/eventi coolify on`, `/eventi truenas off`, `/eventi tdarr stato`

La configurazione HTTP richiede un token di almeno 32 caratteri, da generare casualmente e mantenere fuori dal repository. Le diagnosi Claude chiamano l'adapter con `readOnly=true`; gli eventi con provider Codex producono soltanto una notifica nel topic. I programmi esplicitamente richiesti dall'utente chiamano l'adapter con `readOnly=false` e restano soggetti alle normali protezioni del provider.

`validateTarget` è obbligatoria e deve ricontrollare autorizzazione, topic e progetto corrente prima di ogni invio automatico e avvio agente. Una destinazione revocata non riceve neppure notifiche Codex o messaggi di errore. I log di errore dell’adapter e gli errori mostrati da `/programmi` sono generici e non espongono il testo grezzo del provider.

Un singolo evento può raggiungere fino a 100 sottoscrizioni: il ricevitore accoda le destinazioni del batch e avvia al massimo due diagnosi contemporaneamente per impostazione predefinita. Le destinazioni in attesa riservano il proprio scope; la chiusura elimina la coda e interrompe i lavori attivi. Quando tutti gli slot sono già occupati, i nuovi eventi ricevono `429` senza consumare il loro ID. Questo permette il fan-out a più di due topic mantenendo il limite di concorrenza.
