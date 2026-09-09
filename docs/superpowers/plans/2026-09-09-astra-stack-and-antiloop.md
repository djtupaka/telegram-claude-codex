# Astra Stack and Non-Destructive Anti-Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the Telegram development bot to GPT-6 Astra by default, retain Sol as a safe fallback, refine Superpowers without weakening engineering safeguards, and add progress diagnostics that never terminate healthy work.

**Architecture:** Keep model selection in the provider abstraction, classify a safe Astra fallback only before any observable work, and record progress in the existing run registry. Keep inactivity handling observational: Telegram may warn once per inactivity episode, while only the operator's existing `/stop` action can terminate a run. Install a versioned, reviewable Superpowers policy from repository-owned sources so the global change is reversible.

**Tech Stack:** Bun, TypeScript, Effect 4 beta, Grammy, `@openai/codex-sdk`, Claude Agent SDK, systemd user services, Markdown skill packages.

## Global Constraints

- GPT-6 Astra with `medium` effort is the default for new Codex sessions; GPT-5.6 Sol remains selectable.
- Existing in-flight runs are never changed; cutover happens only after a disposable Astra test succeeds.
- Never switch models after observable work has started and never replay a partially executed turn.
- `RUN_TIMEOUT_MS` remains unset; inactivity and repetition handling must never abort a generator, kill a process, restart the bot, clear a session, or roll back files.
- `/stop` remains the only operator action that terminates an active run.
- Preserve root-cause diagnosis, isolation for risky work, approval for destructive or scope-expanding actions, proportional testing, review, and verification-before-completion.
- Do not repeat equivalent commands, tests, hypotheses, or blocker reports without new evidence; stop the current agent turn after three equivalent failed attempts and preserve state.
- Update exact stable versions only: Codex SDK/CLI `0.153.4`, Happy `1.2.3`, Claude Agent SDK `0.3.266`, native Claude Code `2.1.266`, and Grammy `1.46.0`.
- Do not update Bun, Node, Effect beta, Execa, Groq SDK, TypeScript, Biome, or Ultracite.
- Do not delete or rotate Codex, Claude, Happy, or Telegram history.
- Perform one controlled bot restart after all offline checks and the disposable Astra test pass; do not restart Happy daemons.

---

## File Map

- `src/agent/types.ts`: provider defaults and active-run progress contract.
- `src/agent/preferences.ts`: pure resolution of stored/default model and effort choices.
- `src/agent/preferences.test.ts`: provider-choice and migration regressions.
- `src/agent/codex.ts`: Astra/Sol catalog, effort catalog, and Codex event metadata.
- `src/agent/claude.ts`: documented `max` effort option.
- `src/agent/index.ts`: provider-default and run-progress accessors.
- `src/agent/run-registry.ts`: `lastProgressAt` tracking without cancellation.
- `src/agent/run-registry.test.ts`: progress timestamps and explicit-stop-only behavior.
- `src/agent/astra-fallback.ts`: pure safe-fallback decision.
- `src/agent/astra-fallback.test.ts`: capacity, partial-work, and retry-boundary tests.
- `src/telegram.ts`: stream progress classification and deduplicated inactivity warning.
- `src/telegram.test.ts`: fake-timer warning tests and proof that the stream is not aborted.
- `src/config.ts`, `.env.example`, `README.md`: inactivity-warning configuration; timeout remains disabled.
- `src/bot.ts`: effective model selection, one safe Sol retry, richer `/status`, and package version use.
- `src/version-info.ts`, `src/version-info.test.ts`: bounded sanitized version diagnostics.
- `src/index.ts`: one startup dependency summary.
- `src/agent/codex-history.ts`: read-only active rollout size lookup.
- `src/agent/codex-history.test.ts`: temporary-rollout size and selection tests.
- `package.json`, `bun.lock`: exact project dependency versions and bot version `0.1.0`.
- `policy/superpowers/using-superpowers/SKILL.md`: canonical conservative skill-selection policy.
- `policy/superpowers/brainstorming/SKILL.md`: canonical material-change-only design gate.
- `scripts/superpowers-policy.ts`, `scripts/superpowers-policy.test.ts`: atomic install, backup, validation, and restore support.
- `AGENTS.md`, `CLAUDE.md`: remove the unresolved `quality-code` reference and document the anti-loop contract.

---

### Task 1: Upgrade the Project SDKs and Define Astra Defaults

**Files:**
- Create: `src/agent/preferences.ts`
- Create: `src/agent/preferences.test.ts`
- Modify: `src/agent/types.ts`
- Modify: `src/agent/index.ts`
- Modify: `src/agent/codex.ts`
- Modify: `src/agent/claude.ts`
- Modify: `src/state.ts`
- Modify: `src/state.test.ts`
- Modify: `package.json`
- Modify: `bun.lock`

**Interfaces:**
- Produces: `resolveModelChoice(provider, stored): string`, `resolveEffortChoice(provider, stored): string`, `AgentProvider.defaultModel`, and `getDefaultModel(providerId): string`.
- Produces: state schema version `2`, whose one-time migration changes the pre-cutover Codex selection `undefined`, `default`, or `gpt-5.6-sol` to `gpt-6-astra` while preserving explicit Terra/Luna selections.
- Produces: exported `parseStateForTest(text): ParsedState` as a test-only alias over the same pure parser used by `readStateFile`; production loading must not have a second parser.

- [ ] **Step 1: Write failing provider-choice and state-migration tests**

```ts
test("Codex defaults to Astra medium while preserving Sol as a choice", () => {
  expect(codexProvider.defaultModel).toBe("gpt-6-astra");
  expect(codexProvider.defaultEffort).toBe("medium");
  expect(codexProvider.models.map(({ id }) => id)).toContain("gpt-5.6-sol");
  expect(codexProvider.effortLevels.map(({ id }) => id)).toEqual([
    "low", "medium", "high", "xhigh", "max",
  ]);
});

test("version-1 Sol choice migrates once to Astra", () => {
  const parsed = parseStateForTest(JSON.stringify({
    version: 1,
    activeProvider: "codex",
    activeProject: "",
    models: { codex: "gpt-5.6-sol" },
  }));
  expect(parsed.models.codex).toBe("gpt-6-astra");
  expect(parsed.needsPersist).toBe(true);
});

test("version-2 explicit Sol choice is preserved", () => {
  const parsed = parseStateForTest(JSON.stringify({
    version: 2,
    activeProvider: "codex",
    activeProject: "",
    models: { codex: "gpt-5.6-sol" },
  }));
  expect(parsed.models.codex).toBe("gpt-5.6-sol");
});
```

- [ ] **Step 2: Run the focused tests and confirm the expected failures**

Run: `bun test src/agent/preferences.test.ts src/state.test.ts`

Expected: FAIL because `defaultModel`, `resolveModelChoice`, schema version 2, and the Astra catalog do not exist.

- [ ] **Step 3: Implement provider defaults and the one-time state migration**

```ts
export const resolveModelChoice = (
  provider: AgentProvider,
  stored?: string
) => !stored || stored === "default" ? provider.defaultModel : stored;

export const resolveEffortChoice = (
  provider: AgentProvider,
  stored?: string
) => !stored || stored === "default" ? provider.defaultEffort : stored;
```

Add `defaultModel: string` to `AgentProvider`. Set Codex to `gpt-6-astra`/`medium`, with models `default`, Astra, Sol, Terra, Luna and efforts `low`, `medium`, `high`, `xhigh`, `max`. Set Claude's existing default model sentinel unchanged and append `max` to its effort list. Increment `STATE_VERSION` to `2`; persist a migrated state atomically during load only when the source version is older.

- [ ] **Step 4: Pin project packages and regenerate the lockfile**

Run:

```bash
bun add --exact @openai/codex-sdk@0.153.4 @anthropic-ai/claude-agent-sdk@0.3.266 grammy@1.46.0
```

Set `package.json` version to `0.1.0`. Confirm no unrelated direct dependency changed with `git diff -- package.json bun.lock`.

- [ ] **Step 5: Run focused verification**

Run: `bun test src/agent/preferences.test.ts src/state.test.ts src/agent/claude.test.ts`

Expected: all focused tests pass and TypeScript accepts both providers' catalogs.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock src/agent/types.ts src/agent/index.ts src/agent/preferences.ts src/agent/preferences.test.ts src/agent/codex.ts src/agent/claude.ts src/state.ts src/state.test.ts
git commit -m "feat: make Astra the controlled Codex default"
```

---

### Task 2: Add a Single Safe Astra-to-Sol Start Fallback

**Files:**
- Create: `src/agent/astra-fallback.ts`
- Create: `src/agent/astra-fallback.test.ts`
- Modify: `src/telegram.ts`
- Modify: `src/telegram.test.ts`
- Modify: `src/bot.ts`

**Interfaces:**
- Consumes: `resolveModelChoice()` and `resolveEffortChoice()` from Task 1.
- Produces: `shouldFallbackToSol(input): boolean`, where `input` contains `provider`, `model`, `errorMessage`, `observableWorkStarted`, `resumedSession`, and `fallbackAttempted`.
- Produces: `StreamResult.errorMessage?: string` and `StreamResult.observableWorkStarted?: boolean`.

- [ ] **Step 1: Write the fallback decision tests**

```ts
test("allows one Sol fallback for an Astra capacity failure before work", () => {
  expect(shouldFallbackToSol({
    provider: "codex",
    model: "gpt-6-astra",
    errorMessage: "Selected model is at capacity. Please try a different model.",
    observableWorkStarted: false,
    resumedSession: false,
    fallbackAttempted: false,
  })).toBe(true);
});

test.each([
  { observableWorkStarted: true, resumedSession: false, fallbackAttempted: false },
  { observableWorkStarted: false, resumedSession: true, fallbackAttempted: false },
  { observableWorkStarted: false, resumedSession: false, fallbackAttempted: true },
])("never replays partial work or retries twice", (flags) => {
  expect(shouldFallbackToSol({
    provider: "codex",
    model: "gpt-6-astra",
    errorMessage: "Selected model is at capacity.",
    ...flags,
  })).toBe(false);
});
```

Also cover a generic provider failure, Telegram failure, local `AtCapacity`, Sol failure, and empty error text; all must return `false`.

- [ ] **Step 2: Run the new test and confirm it fails**

Run: `bun test src/agent/astra-fallback.test.ts`

Expected: FAIL because the decision function does not exist.

- [ ] **Step 3: Implement the pure fail-closed decision**

```ts
const START_FAILURE = /selected model.*(?:capacity|unavailable)|model.*not available/i;

export const shouldFallbackToSol = (input: FallbackInput) =>
  input.provider === "codex" &&
  input.model === "gpt-6-astra" &&
  !input.observableWorkStarted &&
  !input.resumedSession &&
  !input.fallbackAttempted &&
  START_FAILURE.test(input.errorMessage ?? "");
```

In `streamToTelegram`, set `observableWorkStarted` only for text, tool, agent, plan, or non-empty result output; retain the exact error message separately. Reasoning and session initialization alone do not count as externally observable work.

- [ ] **Step 4: Refactor `runSinglePrompt` into bounded attempts**

Resolve the effective model and effort once. Execute Astra once. If and only if `shouldFallbackToSol` returns true for a brand-new session, clear only the newly created failed session, send one explicit Telegram notice, and execute the original prompt once with `model: "gpt-5.6-sol"` and a new run id. Never auto-fallback a resumed session. Do not change the persisted Astra default. Return after Sol completes or fails.

```ts
for (const attempt of attempts) {
  const result = await executeAttempt(attempt);
  if (!shouldFallbackToSol({ ...attempt, ...result })) return result;
  await clearSession(project, "codex");
  await ctx.reply("Astra non disponibile prima dell'avvio: riprovo una volta con Sol. Nessun lavoro è stato ripetuto.");
}
```

The `attempts` collection is bounded to Astra plus one Sol attempt. It must never be appended to while iterating.

- [ ] **Step 5: Verify fallback integration**

Run: `bun test src/agent/astra-fallback.test.ts src/telegram.test.ts`

Expected: all tests pass; a partial-work fixture proves that no second generator is requested.

- [ ] **Step 6: Commit**

```bash
git add src/agent/astra-fallback.ts src/agent/astra-fallback.test.ts src/telegram.ts src/telegram.test.ts src/bot.ts
git commit -m "feat: bound Astra capacity fallback to one safe retry"
```

---

### Task 3: Add Progress Age and Non-Destructive Inactivity Warnings

**Files:**
- Create: `src/agent/inactivity-watch.ts`
- Create: `src/agent/inactivity-watch.test.ts`
- Modify: `src/agent/types.ts`
- Modify: `src/agent/run-registry.ts`
- Modify: `src/agent/run-registry.test.ts`
- Modify: `src/agent/index.ts`
- Modify: `src/telegram.ts`
- Modify: `src/telegram.test.ts`
- Modify: `src/config.ts`
- Modify: `src/telegram/bot-service.ts`
- Modify: `src/bot.ts`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Produces: `ActiveRunSnapshot.lastProgressAt: number` and `noteRunProgress(userId, runId, at?)`.
- Produces: `InactivityWatch.touch(now)` and `InactivityWatch.poll(now): boolean`.
- Produces: `RUN_INACTIVITY_WARNING_MS`, default `1_200_000` (20 minutes); `0` disables warnings.

- [ ] **Step 1: Write failing progress and warning tests**

```ts
test("progress advances only the matching active run", async () => {
  const before = await rt.runPromise(getRunSnapshot(899));
  await rt.runPromise(noteRunProgress(899, "wrong-run", 5000));
  expect((await rt.runPromise(getRunSnapshot(899)))?.lastProgressAt)
    .toBe(before?.lastProgressAt);
  await rt.runPromise(noteRunProgress(899, "run-899", 6000));
  expect((await rt.runPromise(getRunSnapshot(899)))?.lastProgressAt).toBe(6000);
});

test("warns once per inactivity episode and re-arms after progress", () => {
  const watch = new InactivityWatch(1000, 0);
  expect(watch.poll(999)).toBe(false);
  expect(watch.poll(1000)).toBe(true);
  expect(watch.poll(2000)).toBe(false);
  watch.touch(2100);
  expect(watch.poll(3100)).toBe(true);
});
```

- [ ] **Step 2: Run focused tests and confirm expected failures**

Run: `bun test src/agent/inactivity-watch.test.ts src/agent/run-registry.test.ts src/telegram.test.ts`

Expected: FAIL because progress timestamps and the watcher do not exist.

- [ ] **Step 3: Implement progress metadata without cancellation**

Initialize `startedAt` and `lastProgressAt` to the same time in `RunRegistry.start`. Update progress through a run-id-guarded accessor as each meaningful `AgentEvent` is consumed. Never call `stopRun`, `AbortController.abort`, `FiberMap.remove`, or `clearSession` from progress code.

- [ ] **Step 4: Implement the warning-only stream timer**

Pass `inactivityWarningMs` into `createBot` from `BotService`. `streamToTelegram` polls the pure watcher and sends at most one warning per episode:

```ts
await ctx.api.sendMessage(
  chatId,
  "Nessun nuovo evento da 20 minuti. Il lavoro continua: non ho fermato il processo. Usa /status per controllare o /stop solo se vuoi interromperlo."
);
```

Touch the watcher when a meaningful event arrives. Clear only the warning interval in `finally`; never affect the event generator.

- [ ] **Step 5: Extend `/status`**

When a snapshot exists, render both elapsed runtime and last-progress age. Do not infer a hang or label the run failed.

```text
Running: Yes (codex, 42m 10s)
Last progress: 3m 08s ago
```

- [ ] **Step 6: Verify no-timeout behavior**

Run: `bun test src/agent/inactivity-watch.test.ts src/agent/run-registry.test.ts src/telegram.test.ts`

Expected: all tests pass, including the existing test proving `Option.none()` leaves a hung SDK active until explicit `stopRun`.

- [ ] **Step 7: Commit**

```bash
git add src/agent/inactivity-watch.ts src/agent/inactivity-watch.test.ts src/agent/types.ts src/agent/run-registry.ts src/agent/run-registry.test.ts src/agent/index.ts src/telegram.ts src/telegram.test.ts src/config.ts src/telegram/bot-service.ts src/bot.ts .env.example README.md
git commit -m "feat: warn on inactivity without stopping agent runs"
```

---

### Task 4: Add Accurate Version and Session Diagnostics

**Files:**
- Create: `src/version-info.ts`
- Create: `src/version-info.test.ts`
- Modify: `src/index.ts`
- Modify: `src/bot.ts`
- Modify: `src/agent/codex-history.ts`
- Create: `src/agent/codex-history.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `readBotVersion(path?): string`, fallback literal `unknown`.
- Produces: `collectRuntimeVersions(runCommand?): Promise<RuntimeVersions>` with a two-second per-command bound and sanitized single-line values.
- Produces: `getCodexSessionFileInfo(sessionId): { path: string; sizeBytes: number } | undefined`.

- [ ] **Step 1: Write failing diagnostics tests**

```ts
test("package metadata failure returns unknown", () => {
  expect(readBotVersion("/missing/package.json")).toBe("unknown");
});

test("runtime diagnostics omit command errors and sanitize newlines", async () => {
  const versions = await collectRuntimeVersions(async (cmd) =>
    cmd === "codex" ? "codex-cli 0.153.4\nignored" : undefined
  );
  expect(versions.codexCli).toBe("codex-cli 0.153.4");
  expect(JSON.stringify(versions)).not.toContain("undefined");
});
```

Add a codex-history fixture proving the exact active rollout is selected and its byte size is returned without modifying the file.

- [ ] **Step 2: Run diagnostics tests and confirm failure**

Run: `bun test src/version-info.test.ts src/agent/codex-history.test.ts`

Expected: FAIL because the new interfaces do not exist. If `codex-history.test.ts` does not exist, create it with a temporary `CODEX_HOME` fixture before running.

- [ ] **Step 3: Implement bounded sanitized diagnostics**

Read SDK versions from package metadata and CLI versions from `codex --version`, `claude --version`, `bun --version`, and `happy --version`. Each process has a two-second timeout, stdout is truncated to its first line and 120 characters, and failures become omitted fields. Never log environment variables or command stderr.

- [ ] **Step 4: Use one version source and add the rollout warning**

Remove `bot.ts`'s local `readVersion`. Import `BOT_VERSION` from `version-info.ts` for lifecycle and run events. At startup, log one sanitized JSON dependency summary. In `/status`, when the active Codex rollout exceeds `104_857_600` bytes, add:

```text
Session warning: Codex context file exceeds 100 MiB; consider /new after the current work phase.
```

The status path remains read-only and does not rotate, truncate, archive, or delete anything.

- [ ] **Step 5: Verify diagnostics**

Run: `bun test src/version-info.test.ts src/agent/codex-history.test.ts src/observability.test.ts`

Expected: all tests pass; telemetry fixtures contain `0.1.0`, never `0.0.0`.

- [ ] **Step 6: Commit**

```bash
git add src/version-info.ts src/version-info.test.ts src/index.ts src/bot.ts src/agent/codex-history.ts src/agent/codex-history.test.ts package.json
git commit -m "feat: expose bounded runtime and session diagnostics"
```

---

### Task 5: Refine and Version the Superpowers Policy

**Files:**
- Create: `policy/superpowers/using-superpowers/SKILL.md`
- Create: `policy/superpowers/brainstorming/SKILL.md`
- Create: `scripts/superpowers-policy.ts`
- Create: `scripts/superpowers-policy.test.ts`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Produces: `validatePolicy(texts): PolicyViolation[]`.
- Produces CLI commands: `bun run scripts/superpowers-policy.ts check`, `install`, and `restore <backup-dir>`.
- Installs only to `/home/djtupaka/.codex/skills/{using-superpowers,brainstorming}/SKILL.md` after exact validation and creates a timestamped backup under `/home/djtupaka/.codex/skill-policy-backups/`.

- [ ] **Step 1: Write failing policy validation and backup tests**

```ts
test("rejects a policy that weakens root-cause or completion verification", () => {
  expect(validatePolicy({
    usingSuperpowers: "skip diagnosis and claim success without tests",
    brainstorming: "all changes are trivial",
  })).toContainEqual(expect.objectContaining({ severity: "error" }));
});

test("accepts proportional process plus the three-attempt boundary", () => {
  const result = validatePolicy(APPROVED_POLICY_FIXTURE);
  expect(result).toEqual([]);
});
```

Use a temporary destination to prove `install` writes both canonical files atomically and `restore` reproduces the exact pre-install bytes.

- [ ] **Step 2: Run policy tests and confirm failure**

Run: `bun test scripts/superpowers-policy.test.ts`

Expected: FAIL because the validator and installer do not exist.

- [ ] **Step 3: Write the canonical conservative policy**

The canonical `using-superpowers` policy must still require checking applicable skills before action. It must explicitly state that skills scale to task risk and that read-only answers/status checks do not invoke design ceremony. The canonical `brainstorming` trigger is limited to materially new behavior, architecture, workflows, and UI; narrow fixes with an already approved outcome use systematic debugging and TDD directly.

Both policies must contain the shared repetition rule verbatim:

```text
Do not repeat an equivalent command, test, hypothesis, or blocker report without new evidence or a relevant state change. After three materially equivalent failed attempts, stop the current turn, preserve state, and report the blocker and evidence. Do not stop the host application or destroy the session.
```

- [ ] **Step 4: Implement fail-closed installation and restoration**

`check` validates canonical and installed files. `install` first validates canonical files, captures SHA-256 and exact backups, then uses same-directory temporary files plus atomic rename. If either destination fails, restore both originals. `restore` accepts only a backup directory created by the script and validates its manifest before writing.

- [ ] **Step 5: Remove the missing skill reference and document precedence**

Remove the nonexistent `.agents/skills/quality-code/SKILL.md` instruction from both `AGENTS.md` and `CLAUDE.md`. Add a concise section saying user instructions override skill guidance, safety invariants remain binding, and proportional verification ends once fresh evidence satisfies the task.

- [ ] **Step 6: Verify and install the policy**

Run:

```bash
bun test scripts/superpowers-policy.test.ts
bun run scripts/superpowers-policy.ts check
bun run scripts/superpowers-policy.ts install
bun run scripts/superpowers-policy.ts check
```

Expected: tests pass; `check` reports both installed hashes matching canonical policy; output prints the backup directory. Do not restart or terminate any existing Codex/Happy session—the new skill text applies when a future session loads it.

- [ ] **Step 7: Commit**

```bash
git add policy/superpowers scripts/superpowers-policy.ts scripts/superpowers-policy.test.ts AGENTS.md CLAUDE.md
git commit -m "feat: make Superpowers proportional and loop resistant"
```

---

### Task 6: Full Verification, Controlled Cutover, and One Restart

**Files:**
- Modify if required by verified results only: `.env`
- No source changes are expected in this task.

**Interfaces:**
- Consumes all prior task outputs.
- Produces a verified bot service running Codex `0.153.4`, defaulting new Codex work to Astra `medium`, with installed policy hashes and non-destructive diagnostics.

- [ ] **Step 1: Verify dependency scope and repository cleanliness**

Run:

```bash
npm view @openai/codex version
npm view @openai/codex-sdk version
npm view happy version
npm view @anthropic-ai/claude-agent-sdk version
npm view grammy version
git diff --check
```

Expected versions: `0.153.4`, `0.153.4`, `1.2.3`, `0.3.266`, `1.46.0`; no whitespace errors.

- [ ] **Step 2: Run proportional focused and complete project checks once**

Run:

```bash
bun test
bun run typecheck
bun run lint
```

Expected: zero test failures, zero TypeScript errors, and zero lint errors. Do not repeat the full suite without a subsequent code change or a failure that requires new evidence.

- [ ] **Step 3: Run a production-startup smoke test without consuming Telegram updates**

Instantiate the app layers with a test BotService or invalid polling stub, assert configuration and provider registry initialization, then dispose the runtime. Do not start a second live Telegram poller.

- [ ] **Step 4: Test Astra in a disposable isolated session**

Use the project-local Codex `0.153.4` with `gpt-6-astra` and `medium` in a temporary local git repository. The prompt may only read a fixture and return a fixed token; it must have no network mutation, deployment, or production credentials. Confirm exit code `0`, exact model acceptance, and no repository changes.

- [ ] **Step 5: Update global tools only after the project-local test succeeds**

Capture the current versions, then run explicit updates:

```bash
npm install -g @openai/codex@0.153.4 happy@1.2.3
claude update 2.1.266
```

Verify `codex --version`, `happy --version`, and `claude --version`. Do not restart Happy daemons. If native Claude's updater does not support an explicit version, stop and use its official stable update command only after recording the exact current symlink target for rollback.

- [ ] **Step 6: Prepare cutover without interrupting active work**

Confirm the bot has no active run through `/status` or the service event log. Ensure `.env` leaves `RUN_TIMEOUT_MS` unset and sets `RUN_INACTIVITY_WARNING_MS=1200000`. Remove the inert legacy `CODEX_MODEL` and `CODEX_REASONING_EFFORT` lines only after confirming the current code never reads them; the effective model comes from the provider default and persisted bot state. Stop if an active run exists.

- [ ] **Step 7: Perform one controlled service restart**

Run the repository's service restart command once:

```bash
bun run service:restart
```

Do not issue a second restart unless verification proves startup failed and rollback is required.

- [ ] **Step 8: Verify live operation**

Run:

```bash
bun run service:status
journalctl --user -u ubuntu-dev-bot --since "5 minutes ago" --no-pager
```

Expected: `active (running)`, one sanitized dependency summary, Codex `0.153.4`, no secret values, no restart loop, and no new unhandled error. Through Telegram, confirm `/status`, `/model`, and `/effort` show Astra medium, Sol, and `max`; send one harmless read-only prompt and confirm a response.

- [ ] **Step 9: Roll back only on verified failure**

If live verification fails, restore the pre-task git commit, the explicit previous global package versions, the native Claude symlink target, and the Superpowers backup printed by Task 5, then restart the bot once and verify recovery. Do not delete histories or alter unrelated services.

- [ ] **Step 10: Commit any environment documentation only**

Do not commit `.env` or credentials. If live verification required documentation corrections, commit only those tracked docs:

```bash
git add README.md .env.example
git commit -m "docs: record Astra bot operating defaults"
```
