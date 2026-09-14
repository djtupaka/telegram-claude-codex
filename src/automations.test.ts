import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeAutomationScheduler,
  makeAutomationStore,
  nextScheduledTime,
} from "./automations";

const dirs: string[] = [];
function store() {
  const dir = mkdtempSync(join(tmpdir(), "automation-"));
  dirs.push(dir);
  return makeAutomationStore(join(dir, "jobs.json"));
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
const target = {
  scopeKey: "t:-1:2",
  chatId: -1,
  threadId: 2,
  project: "/tmp",
  provider: "codex" as const,
};
test("daily scheduling observes Rome DST and skips nonexistent spring hour", () => {
  expect(
    nextScheduledTime(
      { kind: "daily", time: "09:00" },
      Date.parse("2026-03-28T09:00:00Z")
    )
  ).toBe("2026-03-29T07:00:00.000Z");
  expect(
    nextScheduledTime(
      { kind: "daily", time: "02:30" },
      Date.parse("2026-03-29T00:00:00Z")
    )
  ).toBe("2026-03-30T00:30:00.000Z");
  expect(() =>
    nextScheduledTime({ kind: "daily", time: "25:00" }, Date.now())
  ).toThrow();
});
test("persistent jobs freeze targets and cancellation is scope isolated", () => {
  const s = store();
  const job = s.add({
    ...target,
    prompt: "Controlla",
    schedule: { kind: "daily", time: "09:00" },
  });
  expect(s.list(target.scopeKey)[0]).toEqual(job);
  expect(s.cancel("other", job.id)).toBe(false);
  expect(s.cancel(target.scopeKey, job.id)).toBe(true);
  expect(s.list(target.scopeKey)).toHaveLength(0);
});
test("late restart executes at most once, persists claim before execution", async () => {
  const s = store();
  s.add(
    {
      ...target,
      prompt: "Controlla",
      schedule: { kind: "daily", time: "09:00" },
    },
    Date.parse("2026-01-01T00:00:00Z")
  );
  let calls = 0;
  const scheduler = makeAutomationScheduler({
    store: s,
    run: async () => {
      calls++;
    },
  });
  await scheduler.tick(Date.parse("2026-01-10T12:00:00Z"));
  await scheduler.tick(Date.parse("2026-01-10T12:00:00Z"));
  expect(calls).toBe(1);
  expect(s.list(target.scopeKey)[0]?.nextRunAt).toBe(
    "2026-01-11T08:00:00.000Z"
  );
});
test("busy scope retains one due job without overlap and cancelled run aborts", async () => {
  const s = store();
  const job = s.add(
    {
      ...target,
      prompt: "Controlla",
      schedule: { kind: "once", at: "2026-01-02T00:00:00Z" },
    },
    Date.parse("2026-01-01")
  );
  let signal: AbortSignal | undefined;
  let release = () => {
    /* Assigned when the run starts. */
  };
  const scheduler = makeAutomationScheduler({
    store: s,
    run: async (_, sig) => {
      signal = sig;
      await new Promise<void>((r) => {
        release = r;
      });
    },
  });
  const first = scheduler.tick(Date.parse("2026-01-03"));
  await scheduler.tick(Date.parse("2026-01-03"));
  expect(signal?.aborted).toBe(false);
  s.cancel(target.scopeKey, job.id);
  expect(signal?.aborted).toBe(true);
  release();
  await first;
});
test("subscriptions persist frozen context and replace only matching source scope", () => {
  const s = store();
  s.subscribe({ ...target, source: "coolify" });
  s.subscribe({ ...target, source: "coolify", project: "/other" });
  expect(s.subscriptions("coolify")).toHaveLength(1);
  expect(s.subscriptions("coolify")[0]?.project).toBe("/other");
  expect(s.unsubscribe("other", "coolify")).toBe(false);
  expect(s.unsubscribe(target.scopeKey, "coolify")).toBe(true);
});
test("failed one-shot stores failure and never silently retries after restart", async () => {
  const s = store();
  const job = s.add(
    {
      ...target,
      prompt: "Controlla",
      schedule: { kind: "once", at: "2026-01-02T00:00:00Z" },
    },
    Date.parse("2026-01-01")
  );
  const scheduler = makeAutomationScheduler({
    store: s,
    run: async () => {
      throw new Error("Provider non disponibile");
    },
  });
  await scheduler.tick(Date.parse("2026-01-03"));
  expect(s.list()[0]?.lastResult).toBe("error");
  expect(s.list()[0]?.lastError).toBe("Provider non disponibile");
  expect(s.list()[0]?.completed).toBe(true);
  expect(s.cancel(target.scopeKey, job.id)).toBe(true);
});
test("fall-back daily time executes only once", async () => {
  const s = store();
  s.add(
    {
      ...target,
      prompt: "Controlla",
      schedule: { kind: "daily", time: "02:30" },
    },
    Date.parse("2026-10-24T12:00:00Z")
  );
  let count = 0;
  const scheduler = makeAutomationScheduler({
    store: s,
    run: async () => {
      count++;
    },
  });
  await scheduler.tick(Date.parse("2026-10-25T00:30:00Z"));
  await scheduler.tick(Date.parse("2026-10-25T01:30:00Z"));
  expect(count).toBe(1);
  expect(s.list()[0]?.nextRunAt).toBe("2026-10-26T01:30:00.000Z");
});
test("externally busy scope defers, timeout aborts and marks cancelled", async () => {
  const s = store();
  s.add(
    {
      ...target,
      prompt: "Controlla",
      schedule: { kind: "once", at: "2026-01-02T00:00:00Z" },
    },
    Date.parse("2026-01-01")
  );
  let busy = true;
  let count = 0;
  const scheduler = makeAutomationScheduler({
    store: s,
    isBusy: () => busy,
    timeoutMs: 5,
    run: async (_, signal) => {
      count++;
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      );
    },
  });
  await scheduler.tick(Date.parse("2026-01-03"));
  expect(count).toBe(0);
  busy = false;
  await scheduler.tick(Date.parse("2026-01-03"));
  expect(count).toBe(1);
  expect(s.list()[0]?.lastResult).toBe("cancelled");
});
test("daily next occurrence is not skipped across spring DST", async () => {
  const s = store();
  s.add(
    {
      ...target,
      prompt: "Controlla",
      schedule: { kind: "daily", time: "09:00" },
    },
    Date.parse("2026-03-28T00:00:00Z")
  );
  await makeAutomationScheduler({
    store: s,
    run: async () => {
      /* success */
    },
  }).tick(Date.parse("2026-03-28T08:00:00Z"));
  expect(s.list()[0]?.nextRunAt).toBe("2026-03-29T07:00:00.000Z");
});
test("malformed stored targets fail closed instead of launching an undefined project", () => {
  const dir = mkdtempSync(join(tmpdir(), "automation-"));
  dirs.push(dir);
  const path = join(dir, "jobs.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      jobs: [{ id: "x", scopeKey: "t:1:2", project: 42 }],
      subscriptions: [],
    })
  );
  expect(() => makeAutomationStore(path).list()).toThrow("non valido");
});
