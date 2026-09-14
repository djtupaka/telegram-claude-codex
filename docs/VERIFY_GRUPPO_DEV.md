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
