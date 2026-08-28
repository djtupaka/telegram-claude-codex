# Codex Telegram Bot Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore reliable Codex Telegram replies, enforce the configured run timeout, preserve the oversized historical thread, and make silent stalls diagnosable without touching Claude.

**Architecture:** Keep `RunRegistry` as the single lifecycle owner: apply timeout and active metadata at its producer boundary, then expose a read-only snapshot to `/status`. Extend the existing best-effort JSONL observability with sanitized receipt/start records. Rotate only the active Codex mapping through a tested atomic helper before one controlled service restart.

**Tech Stack:** Bun 1.3.x, TypeScript, Effect 4 beta, Grammy, OpenAI Codex SDK, systemd user service.

## Global Constraints

- Do not authenticate, configure, update, or test Claude.
- Never delete or truncate historical Codex JSONL sessions.
- Never persist prompt bodies, Telegram text, bot tokens, API keys, or auth data.
- Update only `@openai/codex-sdk` / locked `@openai/codex` to `0.150.1`.
- Use TDD: every behavior change must first fail for the expected reason.
- Production state changes happen only after the full candidate passes test, typecheck, lint, and diff checks.
- Do not send an outbound Telegram test prompt on the user's behalf.

---

### Task 1: Enforce timeout and expose active run metadata

**Files:**
- Modify: `src/agent/types.ts`
- Modify: `src/agent/run-registry.ts`
- Modify: `src/agent/index.ts`
- Modify: `src/agent/run-registry.test.ts`

**Interfaces:**
- Produces `ActiveRunSnapshot` with `runId`, `provider`, and `startedAt`.
- Adds required `runId: string` to `RunOptions`.
- Adds `getRunSnapshot(userId)` alongside `hasRun(userId)`.

- [ ] **Step 1: Write failing timeout tests**

Update the test runtime helper so it accepts `runTimeoutMs: Option.Option<number>` and add tests equivalent to:

```ts
test("configured timeout aborts a hung SDK and clears registry state", async () => {
  const rt = makeRuntime(4, Option.some(40));
  let aborted = false;
  const spec = makeHangingSdkSpec(() => {
    aborted = true;
  });
  const queue = await rt.runPromise(startRun(spec, makeOpts(4001)));
  const terminal = await takeEvent(rt, queue);
  expect(terminal.kind).toBe("error");
  if (terminal.kind === "error") {
    expect(terminal.class?._tag).toBe("AgentTimedOut");
  }
  expect(aborted).toBe(true);
  expect(await rt.runPromise(hasRun(4001))).toBe(false);
});

test("timeout disabled keeps a hung run active until explicit stop", async () => {
  const rt = makeRuntime(4, Option.none());
  const queue = await rt.runPromise(startRun(makeHangingSdkSpec(), makeOpts(4002)));
  await Bun.sleep(60);
  expect(await rt.runPromise(hasRun(4002))).toBe(true);
  await rt.runPromise(stopRun(4002, "stopped"));
  const terminal = await takeEvent(rt, queue);
  expect(terminal.kind).toBe("error");
  if (terminal.kind === "error") {
    expect(terminal.class?._tag).toBe("AgentInterrupted");
  }
});
```

- [ ] **Step 2: Run the new tests and verify RED**

Run: `bun test src/agent/run-registry.test.ts`

Expected: tests fail because `runTimeoutMs` is unused and SDK hangs do not yield `AgentTimedOut`.

- [ ] **Step 3: Add failing active-snapshot lifecycle tests**

Pass `runId: "run-<userId>"` from `makeOpts`; assert `getRunSnapshot` is populated during execution and becomes `undefined` after natural completion, timeout, stop, and provider failure.

```ts
expect(await rt.runPromise(getRunSnapshot(4003))).toMatchObject({
  runId: "run-4003",
  provider: "claude",
});
```

- [ ] **Step 4: Implement the minimal producer-boundary behavior**

Add to `RunOptions`:

```ts
runId: string;
```

In `RunRegistry.make`, keep `const active = new Map<number, ActiveRunSnapshot>()`. Wrap the selected provider effect with:

```ts
const bounded = Option.match(cfg.runTimeoutMs, {
  onNone: () => producer,
  onSome: (ms) =>
    producer.pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(ms),
        orElse: () => Effect.fail(new AgentTimedOut({})),
      })
    ),
});
```

Set metadata immediately before `FiberMap.run`; remove it in the same producer `onExit` that emits the terminal event. Expose `snapshot(userId)` as a copied value, never the mutable map entry.

- [ ] **Step 5: Verify GREEN and regressions**

Run: `bun test src/agent/run-registry.test.ts`

Expected: all registry tests pass, including timeout/disabled/snapshot terminal paths.

- [ ] **Step 6: Commit**

```bash
git add src/agent/types.ts src/agent/run-registry.ts src/agent/index.ts src/agent/run-registry.test.ts
git commit -m "fix: enforce Codex run timeout"
```

### Task 2: Add sanitized receipt/start observability and `/status` detail

**Files:**
- Modify: `src/observability.ts`
- Modify: `src/observability.test.ts`
- Modify: `src/bot.ts`
- Modify: `src/agent/index.ts`
- Modify: `src/telegram.test.ts` or create `src/bot-observability.test.ts`

**Interfaces:**
- Produces `LifecycleEvent` tagged `telegram.update_received` or `telegram.run_started`.
- Produces `recordLifecycle(event)` on `Observability`.
- Consumes `getRunSnapshot(userId)` from Task 1.

- [ ] **Step 1: Write failing ledger tests**

Define strict expectations for a lifecycle row:

```ts
await recordLifecycle(rt, new LifecycleEvent({
  ts: "2026-08-28T00:00:00.000Z",
  event: "telegram.run_started",
  userId: 1,
  runId: "r-1",
  updateId: null,
  updateKind: null,
  provider: "codex",
  project: "premelone",
  model: "gpt-5.6-sol",
  effort: "medium",
  queueDepth: 0,
  version: "0.0.0",
  host: "test-host",
}));
expect(readLines(logPath)[0]).not.toHaveProperty("prompt");
expect(readLines(logPath)[0]).not.toHaveProperty("text");
```

Also test write failures remain best-effort and each call appends exactly one line.

- [ ] **Step 2: Run observability tests and verify RED**

Run: `bun test src/observability.test.ts`

Expected: imports/types fail because lifecycle events do not exist.

- [ ] **Step 3: Implement lifecycle schema and writer**

Create a `LifecycleEvent` schema with nullable fields so both tags share one strict shape. Factor the existing append behavior into a private `appendEncoded` helper used by `recordRun` and `recordLifecycle`. Preserve `catchCause(() => Effect.void)` around the complete operation.

- [ ] **Step 4: Write failing bot integration tests**

Test that a sanitized `update_received` record is emitted after access control and before routing, and that `run_started` is emitted exactly once immediately before `runAgent`. Assert no message body is present. Test `/status` renders `Running: Yes`, provider, and elapsed time from a deterministic snapshot.

- [ ] **Step 5: Implement bot wiring**

Add a middleware after the allowed-user guard:

```ts
bot.use(async (ctx, next) => {
  await emitLifecycle({
    event: "telegram.update_received",
    userId: getUserId(ctx),
    updateId: ctx.update.update_id,
    updateKind: detectUpdateKind(ctx),
  });
  await next();
});
```

Generate `runId` before provider execution, emit `telegram.run_started`, and pass that same `runId` into `RunOptions`. Never include `prompt`, `promptChars` in the receipt event, or absolute project path; use `basename(project)`.

Extend `/status` from the registry snapshot; retain current queue/compose/model/effort lines.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
bun test src/observability.test.ts src/bot-observability.test.ts src/agent/run-registry.test.ts
bun run typecheck
```

Expected: all selected tests and typecheck pass.

- [ ] **Step 7: Commit**

```bash
git add src/observability.ts src/observability.test.ts src/bot.ts src/agent/index.ts src/bot-observability.test.ts
git commit -m "feat: expose Codex run liveness"
```

### Task 3: Add recoverable Codex session rotation

**Files:**
- Create: `scripts/rotate-codex-session.ts`
- Create: `scripts/rotate-codex-session.test.ts`
- Modify: `src/agent/session-store.ts`
- Modify: `src/agent/session-store.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `backupAndClearCodexSession({ dataDir, project, backupDir })`.
- Reuses `makeSessionOps(path).clear(project, "codex")` for atomic mutation.

- [ ] **Step 1: Write failing rotation tests**

Use temporary state/session files and assert:

```ts
const result = backupAndClearCodexSession({ dataDir, project, backupDir });
expect(result.cleared).toBe(true);
expect(readSessions(dataDir)[project].codex).toBeUndefined();
expect(readSessions(dataDir)[project].claude.sessionId).toBe("claude-old");
expect(readState(dataDir)).toEqual(originalState);
expect(statSync(result.stateBackup).mode & 0o777).toBe(0o600);
expect(statSync(result.sessionsBackup).mode & 0o777).toBe(0o600);
```

Also assert an absent Codex mapping is a no-op, a missing source file fails before mutation, and backup paths cannot overwrite an existing backup.

- [ ] **Step 2: Verify RED**

Run: `bun test scripts/rotate-codex-session.test.ts`

Expected: module/function is missing.

- [ ] **Step 3: Implement atomic rotation**

Export the existing store types/helpers needed by the script without exposing real paths. Copy `state.json` and `sessions.json` to a timestamped backup directory, apply `chmodSync(path, 0o600)`, then clear only the selected project's Codex mapping through `makeSessionOps`. Validate postconditions by rereading both files before returning success.

Add package script:

```json
"session:rotate-codex": "bun run scripts/rotate-codex-session.ts"
```

- [ ] **Step 4: Verify GREEN and store regressions**

Run:

```bash
bun test scripts/rotate-codex-session.test.ts src/agent/session-store.test.ts
bun run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add scripts/rotate-codex-session.ts scripts/rotate-codex-session.test.ts src/agent/session-store.ts src/agent/session-store.test.ts package.json
git commit -m "feat: rotate Codex sessions safely"
```

### Task 4: Update the Codex SDK only

**Files:**
- Modify: `package.json`
- Modify: `bun.lock`
- Modify only if required: `src/agent/codex.ts`
- Modify only if required: `src/agent/codex.test.ts`

**Interfaces:**
- Preserve the current `AgentProvider` contract and model/effort behavior.

- [ ] **Step 1: Update the exact dependency**

Run:

```bash
bun add --exact @openai/codex-sdk@0.150.1
```

Confirm the lock resolves both `@openai/codex-sdk` and `@openai/codex` to `0.150.1`, with no unrelated direct dependency changes.

- [ ] **Step 2: Run focused compatibility tests**

```bash
bun test src/agent/codex.test.ts src/agent/codex-env.test.ts src/agent/run-registry.test.ts
bun run typecheck
```

If the SDK API changed, first add a failing regression in `src/agent/codex.test.ts`, then make the smallest adapter-only fix in `src/agent/codex.ts`.

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lock src/agent/codex.ts src/agent/codex.test.ts
git commit -m "chore: update Codex SDK to 0.150.1"
```

### Task 5: Full verification, integration, and controlled service recovery

**Files:**
- Modify: `CLAUDE.md` only if operational commands changed
- Create: `.data/backups/codex-recovery-<timestamp>/` at rollout time (ignored runtime state, mode `0700`)

**Interfaces:**
- Consumes all prior tasks and the approved production state path.

- [ ] **Step 1: Run complete pre-rollout verification**

```bash
bun test
bun run typecheck
bun run lint
git diff --check
git status --short
```

Expected: zero test failures, typecheck/lint clean, no unstaged or unrelated changes.

- [ ] **Step 2: Verify built/runtime dependency resolution**

```bash
bun pm ls | rg '@openai/codex(-sdk)?'
node -e "console.log(require('./node_modules/@openai/codex-sdk/package.json').version)"
```

Expected: `0.150.1` for the SDK/runtime pair.

- [ ] **Step 3: Merge the isolated branch using the approved integration path**

Use a fast-forward or reviewed merge; do not overwrite the local security/model commits or `.env`.

- [ ] **Step 4: Back up and rotate production state**

Run the tested rotation command against `/home/djtupaka/projects/dev-bot/.data`, with a timestamped backup directory. Verify the prior session ID still resolves to its existing 253 MB JSONL file and the Claude mapping is unchanged.

- [ ] **Step 5: Restart once and verify service health**

```bash
systemctl --user restart telegram-claude.service
systemctl --user status telegram-claude.service --no-pager -l
journalctl --user -u telegram-claude.service --since '2 minutes ago' --no-pager
```

Verify: active/running, one new start, no startup exception, Telegram long-poll socket established, `getMe` succeeds, active provider remains Codex, selected model/effort remain unchanged, and Codex login status succeeds. Do not reauthenticate Claude.

- [ ] **Step 6: User acceptance test**

Ask the user to send `/status`, then a short text prompt. Verify persisted sequence:

```text
telegram.update_received
telegram.run_started
telegram.run
```

Confirm the new Codex session ID is persisted and the old JSONL remains untouched.

- [ ] **Step 7: Roll back on failure**

If startup or the user test fails, stop the service, restore backed-up state/session files and prior commit/lockfile, start the prior version, and report the exact failing boundary from lifecycle events. Never delete either Codex thread.
