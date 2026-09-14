# Piano: sessioni per argomento (forum topics) nel gruppo Telegram "Dev"

Obiettivo: usare lo stesso bot (ubuntu-dev-bot) in due posti. Chat privata: invariata.
Gruppo "Dev" (id -1004307670930, Argomenti attivi, bot admin con "Gestisci argomenti"):
ogni argomento e una sessione indipendente (progetto, agente, modello, effort, conversazione),
gli argomenti lavorano in parallelo (tetto MAX_CONCURRENT_RUNS=4). Nuove sessioni con /nuova.

## Concetto: Scope
- `u:<userId>`            chat privata (comportamento attuale, stato persistito globale)
- `t:<chatId>:<threadId>` argomento del gruppo (stato persistito in state.json -> topics[key])
- `control`               argomento "Generale" del gruppo: solo /nuova, /elenco, /start, /help
- chat non private con id non in ALLOWED_CHAT_IDS: ignorate

## Modifiche
1. config.ts: `ALLOWED_CHAT_IDS` (lista, opzionale). index.ts la passa a createBot.
2. src/scope.ts (nuovo): `resolveScope(ctx, allowedUserId, allowedChatIds)`; `topicKey`.
3. state.ts: BotState.scopeKey opzionale; persistState scrive in `topics[scopeKey]` quando presente,
   altrimenti nello stato globale (invariato). `loadTopics()` / `removeTopic(key)`.
4. agent/types.ts RunOptions: `runKey: string` (chiave registry), `sessionKey?: string`.
   run-registry.ts: mappe keyed da string (runKey) invece di userId.
   agent/index.ts: stopAgent/hasActiveProcess/getActiveRunSnapshot/noteAgentProgress su runKey;
   runAgent persiste la sessione su `sessionKey ?? projectDir`.
5. session-store: nessuna modifica di formato; per gli argomenti la chiave progetto diventa
   `<projectDir>#<scopeKey>` (helper `sessionProjectKey(scope, project)` in bot.ts).
6. bot.ts: `scopeStates: Map<string, UserState>`; `getState(scope)`; tutte le chiamate userId ->
   scope.key per registry/stato (userId resta nella telemetria). Middleware: risolve lo scope,
   scarta chat non autorizzate, e per gli argomenti installa `ctx.api.config.use` che aggiunge
   `message_thread_id` a tutti i metodi send*/copy*/forward* senza thread id.
   In scope topic niente pin (il nome dell'argomento gia dice progetto e agente).
   Comandi nuovi (solo nel gruppo): `/nuova [progetto] [claude|codex]` con tastiere inline,
   `/chiudi` (stop + pulizia stato/sessione + closeForumTopic), `/elenco`.
   Testo libero in "Generale" -> suggerimento di usare un argomento o /nuova.
7. src/topics.ts (nuovo): `createTopicSession({api, chatId, projectDir, provider, name})` usato da
   /nuova e dallo script di seed. scripts/topics-seed.ts: crea gli argomenti iniziali.
8. index.ts: setMyCommands aggiunge nuova/chiudi/elenco per il gruppo.
9. Test: scope.test.ts (derivazione scope, chiavi), state.test.ts (topics persist/load),
   run-registry con chiavi string (index.test.ts se copre), telegram thread-id transformer.
10. Docs: README + CLAUDE.md sezione "Gruppo con argomenti".

## Fuori scope
- Topic nella chat privata (Telegram non li supporta).
- Piu utenti.

## Deploy
Branch feat/telegram-topics, test verdi, merge su main, `systemctl --user restart telegram-claude`
SOLO quando nessun run e attivo (il bot e in uso da Nicolas). Poi seed dei 6 argomenti.
