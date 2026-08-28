# Codex Telegram Bot Recovery Design

## Objective

Restore reliable Codex responses in `telegram-claude.service` without touching
Claude authentication or deleting historical sessions. Prevent the same silent
stall from recurring, make run state observable, and update only the Codex
runtime dependency needed for this path.

## Confirmed production facts

- Telegram API and long-poll connection are reachable.
- The service is running with zero restarts and normal CPU, memory, disk, and
  host load.
- Codex authentication is valid; Claude OAuth is expired and is explicitly out
  of scope for this intervention.
- The active Codex conversation is backed by a 253 MB JSONL session file.
- The bot records completed runs but does not persist prompt receipt or run
  start, so a missing reply cannot currently be localized.
- `.env` sets `RUN_TIMEOUT_MS=900000`, but `AppConfig.runTimeoutMs` is never
  consumed by the run registry or runner. The advertised 15-minute timeout is
  therefore ineffective.
- The repository is clean and its 81 tests, typecheck, and lint currently pass.

## Considered approaches

### Restart only

Fastest but weak: it clears in-memory state while preserving the oversized
session and the unused timeout. The same failure can recur without evidence.

### Rotate the session and restart

Likely restores service, and the old session remains recoverable. It still
leaves silent prompt handling and unbounded runs unresolved.

### Full Codex-only recovery (selected)

Rotate the active session safely, enforce the configured timeout, add bounded
run/update observability, update the Codex SDK, verify, and restart. This fixes
the immediate issue and the confirmed recurrence paths while leaving Claude
and unrelated dependencies unchanged.

## Scope and constraints

- Do not authenticate, configure, upgrade, or otherwise change Claude.
- Do not delete the 253 MB Codex session or any historical session.
- Do not log prompt text, bot tokens, API keys, auth files, or Telegram message
  bodies.
- Do not upgrade unrelated major dependencies (`execa`, `groq-sdk`,
  TypeScript, Effect, Biome, or Ultracite).
- Preserve the existing provider/project/model/effort selections.
- Use test-first development and keep the service on the current code until the
  complete candidate passes tests.

## Design

### 1. Enforce the configured run timeout

`RunRegistry.buildProducer` will apply `AppConfig.runTimeoutMs` to both SDK and
subprocess providers. When configured, exceeding the duration produces the
existing typed `AgentTimedOut` terminal event. `Option.none()` keeps the
documented unbounded behavior. Scope finalization continues to abort the SDK
generator and its subprocess.

The timeout is enforced at the producer boundary so permits, `FiberMap` state,
abort controllers, queue termination, and user-visible error classification
all follow the existing single lifecycle.

### 2. Add sanitized lifecycle observability

The persistent JSONL ledger will record two additional event types:

- `telegram.update_received`: update ID, user ID, update kind, and timestamp;
- `telegram.run_started`: run ID, user ID, provider, project basename, model,
  effort, queue depth, and timestamp.

No prompt body, chat text, token, absolute session content, or credentials are
recorded. Existing `telegram.run` remains the terminal record. Together these
events distinguish polling failure, handler failure, provider stall, timeout,
and Telegram rendering failure.

### 3. Expose active-run state safely

`RunRegistry` will retain sanitized metadata for each active user run:
provider, start timestamp, and run ID. It will expose a read-only snapshot used
by `/status` to show:

- whether a run is active;
- provider and elapsed duration when active;
- queue depth and compose state as today.

Metadata is removed by the same producer finalizer on success, typed failure,
timeout, interrupt, and shutdown. It is never persisted as authoritative state,
so a service restart always begins with no phantom active run.

### 4. Rotate the active Codex session recoverably

Before service restart:

1. create a timestamped backup of `.data/state.json` and
   `.data/sessions.json` with mode `0600`;
2. preserve the existing 253 MB Codex JSONL file in place;
3. remove only the active project's Codex session mapping from
   `.data/sessions.json` using the project's atomic-state pattern;
4. retain project, provider, model, effort, and the Claude session mapping.

The next Telegram prompt starts a fresh Codex thread. The previous thread can
still be selected later through history because its JSONL is not removed.

### 5. Update only the Codex SDK pair

Update `@openai/codex-sdk` and its locked `@openai/codex` runtime from `0.147.0`
to `0.150.1`. Do not change the Claude SDK or Telegram/utility dependencies in
this intervention. Any API incompatibility must be resolved behind the current
`AgentProvider` interface and covered by existing and new tests.

### 6. Controlled rollout

After full tests, typecheck, lint, and diff validation:

1. commit the isolated implementation;
2. back up production state;
3. stop the user service once;
4. rotate only the Codex mapping;
5. install the already-locked dependencies if required;
6. start the service once;
7. verify service state, restart count, startup logs, Telegram `getMe`, Codex
   login status, and absence of secret leakage;
8. ask the user to send a short Codex test message.

No automated outbound Telegram test message will be sent on the user's behalf.

## Failure handling and rollback

- If tests or SDK compatibility fail, production remains untouched.
- If startup fails, restore the two backed-up state files and the previous
  lockfile/commit, then start the prior service version.
- If the bot starts but the user's test still fails, preserve the fresh and old
  sessions and use the new lifecycle events to localize whether Telegram,
  handler, provider, timeout, or rendering failed.
- A timed-out run must free its concurrency permit, clear active metadata, end
  its event queue, and allow the next Telegram prompt.

## Verification requirements

- Test proves a hung SDK provider times out with `AgentTimedOut`, aborts, and
  leaves `hasRun(userId) == false`.
- Test proves timeout disabled leaves the provider running until explicit stop.
- Tests prove active metadata appears during a run and disappears on every
  terminal path.
- Tests prove update/run-start records are sanitized and emitted exactly once.
- Tests prove session rotation removes only the selected Codex mapping and
  preserves every other state field and historical file.
- Existing full test suite, typecheck, and lint remain clean.
- Production verification requires a real user-sent Telegram prompt after
  restart; health checks alone are insufficient to claim the bot fixed.

## Explicitly deferred

- Claude OAuth reauthentication and Claude SDK update.
- Upgrades of Grammy and unrelated dependencies.
- Deleting or compacting historical Codex sessions.
- Persisting Telegram message queues across restart.
