# Controlled Agent Stack Update Design

## Objective

Improve the Telegram development bot and its Codex/Claude integrations without
interrupting active work or deleting conversation history. Adopt GPT-6 Astra
with a controlled rollback path and reduce unproductive Superpowers loops while
preserving the engineering safeguards that protect infrastructure and code.

## Current Baseline

- The systemd user service is stable and has not restarted since 7 September.
- The bot uses the project-local Codex SDK/CLI `0.150.1`.
- Happy currently resolves the global Codex CLI `0.144.6`.
- The active bot selection is `gpt-5.6-sol` with `medium` effort; the installed
  Codex build does not expose GPT-6 Astra.
- Claude Agent SDK is `0.3.220`; native Claude Code is `2.1.220` and currently
  reports no active login.
- Happy is `1.2.0`; Grammy resolves to `1.45.1`.
- The existing baseline passes 89 tests, TypeScript type checking, and lint.
- The apparent 6.6 GiB service memory footprint is mostly reclaimable file
  cache; anonymous memory is approximately 312 MiB.

## Version Policy

- Update the bot's Codex SDK and project-local CLI from `0.150.1` to the stable
  release that exposes GPT-6 Astra, currently `0.153.4`, using exact pins.
- Align the global Codex CLI used outside the repository to that same tested
  release only after the project-local validation succeeds.
- Do not install pre-releases. Preserve the exact previous project and global
  versions so rollback does not depend on package resolution at recovery time.
- Update Happy from `1.2.0` to `1.2.3`.
- Update Claude Agent SDK from `0.3.220` to `0.3.266` and native Claude Code
  from `2.1.220` to `2.1.266`.
- Update Grammy from the resolved `1.45.1` to `1.46.0`.
- Do not update Bun, Node, Effect beta, Execa, Groq SDK, TypeScript, Biome, or
  Ultracite in this intervention.
- Preserve exact dependency pins for agent SDKs so future installs remain
  reproducible.

## Bot Improvements

### Accurate Runtime Version

Replace the hard-coded/fallback `0.0.0` telemetry value with the version from
the bot package metadata. Set the initial bot version to `0.1.0` and expose the
same value in lifecycle and run events. Failure to read package metadata must
use the literal fallback `unknown` without preventing startup.

### Startup Diagnostics

At startup, log a single sanitized dependency summary containing the bot,
Codex SDK/CLI, Claude Agent SDK/CLI, Bun, and Happy versions when they can be
resolved. Diagnostics are best-effort, bounded by timeouts, never include
credentials, and never prevent Telegram startup.

Authentication diagnostics remain separate from version diagnostics. Codex
login continues to be checked non-blockingly. Claude's disconnected state is
reported as a warning, not repaired or logged in automatically.

### Model and Reasoning Controls

Add GPT-6 Astra to the Codex model menu and make `gpt-6-astra` with `medium`
effort the default for new Codex sessions. Keep GPT-5.6 Sol selectable as the
known fallback. Add the documented `max` effort option to both Codex and Claude
menus; `high`, `xhigh`, and `max` remain explicit user choices rather than being
selected automatically.

Existing in-flight runs are never changed. A controlled post-update test uses a
disposable session before the production default is activated. At cutover, the
persisted Codex selection is changed once to Astra because the operator
explicitly approved the new default; subsequent explicit model choices remain
persisted normally.

If Astra rejects a turn before doing any work because the model is unavailable
or at capacity, the bot may offer or perform one start-time retry on Sol. It
must not switch models after a turn has started, replay a partially executed
turn, or conceal the fallback from the user.

### Superpowers Policy Refinement

Refine the user-owned Superpowers instructions conservatively. The change must
preserve these safeguards:

- investigate root cause before fixing unexpected behavior;
- use isolation for risky or overlapping development work;
- obtain approval before destructive, externally visible, or materially
  scope-expanding actions;
- test behavior changes in proportion to their risk;
- review substantial changes and verify evidence before claiming completion;
- preserve user changes and stop immediately when the user asks.

Remove only procedural amplification that does not improve those safeguards:

- factual answers, read-only inspections, status checks, and narrowly scoped
  low-risk changes do not require a design document and implementation plan;
- a full brainstorm/spec/plan sequence remains required for genuinely new or
  materially changed behavior, architecture, workflows, or user interfaces;
- do not repeat the same command, test, hypothesis, or blocking report without
  a relevant state change or new evidence;
- after three materially equivalent failed attempts, stop the current agent
  turn, preserve all state, and report the confirmed blocker, evidence, and
  safest next action instead of beginning a fourth attempt;
- once proportional verification passes, do not broaden or repeat it unless a
  new change, failure, or unresolved risk justifies doing so;
- use subagents only for independent bounded work where parallelism materially
  improves latency or review quality.

The policy refinement applies consistently to the bot and normal Codex work,
but must be implemented as a minimal, reviewable change to the user-owned skill
layer. System-distributed skill sources are not edited in place. The existing
missing `quality-code` reference is either restored from an authoritative local
source or removed from the project instructions; no substitute skill is
invented.

### Non-Destructive Loop Detection

Do not introduce a wall-clock run timeout. `RUN_TIMEOUT_MS` remains unset and
`/stop` remains a manual operator action. Long tests, builds, migrations, and
deployments may run for as long as they continue making progress.

Add observation without automatic termination:

- track the last meaningful streamed event for the active run;
- expose elapsed time and last-progress age through status diagnostics;
- send at most one warning when a configurable inactivity threshold is crossed;
- warnings never abort the SDK generator, kill a process, clear a session,
  restart the Telegram bot, or roll back files;
- reset the warning state when meaningful progress resumes;
- avoid notification loops by deduplicating warnings per inactivity episode.

Semantic repetition limits are enforced by the agent instructions. The bot
must not guess that two opaque tool calls are equivalent and kill a healthy run.

### Large Session Warning

When `/status` inspects the active Codex session, report a warning when its
rollout file exceeds 100 MiB. The check is read-only and best-effort. It must
not rotate, archive, compact, truncate, or delete a session. The warning advises
using `/new` only after the current work phase is complete.

## Deployment and Safety

- Develop in an isolated git worktree from the clean `main` branch.
- Use test-first changes for every behavior modification.
- Update project dependencies only inside the worktree.
- Run focused tests after each change, followed by the complete test suite,
  type check, lint, and a production startup smoke test with Telegram startup
  mocked or otherwise prevented from consuming updates.
- Do not restart the live service while an agent run is active.
- Capture current local/global versions before global package changes.
- Global package updates must use explicit versions and be independently
  reversible.
- Perform one controlled service restart after all checks pass.
- Do not restart running Happy daemons or sessions during this intervention;
  the updated global packages apply when those processes next start naturally.
- Verify service status, resolved runtime versions, Telegram update handling,
  and absence of new error events after restart.
- If deployment verification fails, restore the previous project commit and
  explicit global package versions, then restart once and verify recovery.

## Out of Scope

- Automatic per-prompt model routing or mid-turn model switching.
- Automatic session rotation or storage cleanup.
- Removing historical Codex, Claude, or Happy data.
- Automatic process termination based on runtime, inactivity, repeated output,
  or inferred lack of progress.
- Changing permissions, sandboxing, Executor MCP configuration, or Telegram
  access controls.
- Major dependency upgrades and unrelated refactoring.

## Acceptance Criteria

- All existing and new automated tests pass with no lint or type errors.
- The project and global Codex commands both resolve to the same tested stable
  Astra-capable version in their intended contexts.
- Happy resolves to `1.2.3`, Grammy to `1.46.0`, Claude Agent SDK to `0.3.266`,
  and native Claude Code to `2.1.266`.
- Telemetry no longer reports `version: 0.0.0`.
- A disposable new Codex session can run successfully with GPT-6 Astra at
  `medium`; new sessions then default to that selection while Sol remains
  available.
- `/effort` offers `max` without selecting it automatically.
- An Astra start-time capacity/unavailability failure cannot replay partial
  work and produces at most one explicit Sol fallback attempt.
- Superpowers still requires root-cause diagnosis and proportional verification
  but no longer forces a full design ceremony for read-only or narrow low-risk
  work.
- Three equivalent failed attempts end the current turn with a blocker report;
  they do not stop the bot service or destroy the Codex session.
- Inactivity produces one deduplicated diagnostic warning and never terminates
  the active run.
- `/status` warns for the current oversized Codex session without modifying it.
- Claude's missing login is visible but does not prevent Codex operation.
- The bot returns to `active (running)` after one controlled restart and
  processes a Telegram update without adding a new error event.
