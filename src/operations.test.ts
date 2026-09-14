import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  calendarDayRange,
  formatStats,
  makeOperationsStore,
} from "./operations";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});
const temporary = () => {
  const dir = mkdtempSync(join(tmpdir(), "operations-"));
  directories.push(dir);
  return join(dir, "operations.json");
};
const run = {
  scopeKey: "private:1",
  project: "/projects/demo",
  provider: "codex" as const,
  runId: "run-1",
  startedAt: "2026-09-14T10:00:00Z",
  durationMs: 1200,
  costUsd: null,
  totalTokens: null,
  outcome: "done" as const,
};

test("scope settings persist independently with automatic defaults", () => {
  const path = temporary();
  const store = makeOperationsStore(path);
  expect(store.getSettings("one")).toEqual({ approvalPolicy: "automatic" });
  store.patchSettings("one", { approvalPolicy: "ask", pinnedMessageId: 15 });
  expect(makeOperationsStore(path).getSettings("one")).toEqual({
    approvalPolicy: "ask",
    pinnedMessageId: 15,
  });
  expect(store.getSettings("two")).toEqual({ approvalPolicy: "automatic" });
  store.patchSettings("one", { pinnedMessageId: undefined });
  expect(store.getSettings("one")).toEqual({ approvalPolicy: "ask" });
});

test("run deduplication survives reopening and reports unknown costs honestly", () => {
  const path = temporary();
  const store = makeOperationsStore(path);
  expect(store.recordRun(run)).toBe(true);
  expect(makeOperationsStore(path).recordRun(run)).toBe(false);
  const result = makeOperationsStore(path).stats();
  expect(result.runs).toBe(1);
  expect(result.durationMs).toBe(1200);
  expect(result.costUsd).toBeNull();
  expect(result.costReportedRuns).toBe(0);
  expect(result.totalTokens).toBeNull();
  expect(result.outcomes.done).toBe(1);
});

test("aggregates reported metrics and filters scopes and dates", () => {
  const store = makeOperationsStore(temporary());
  store.recordRun(run);
  store.recordRun({
    ...run,
    runId: "run-2",
    scopeKey: "topic:2",
    startedAt: "2026-09-15T10:00:00Z",
    costUsd: 0,
    totalTokens: 50,
    outcome: "errored",
  });
  store.recordRun({ ...run, runId: "run-3", costUsd: 0.25, totalTokens: 100 });
  expect(store.stats().costUsd).toBe(0.25);
  expect(store.stats().costReportedRuns).toBe(2);
  expect(store.stats().totalTokens).toBe(150);
  expect(store.stats().durationMs).toBe(3600);
  expect(store.stats("private:1").runs).toBe(2);
  expect(store.stats(undefined, "2026-09-15T00:00:00Z").runs).toBe(1);
  expect(store.stats().outcomes.errored).toBe(1);
});

test("rejects malformed input and corrupt persisted data without overwriting it", () => {
  const path = temporary();
  const store = makeOperationsStore(path);
  expect(() => store.recordRun({ ...run, durationMs: -1 })).toThrow();
  expect(() => store.recordRun({ ...run, costUsd: Number.NaN })).toThrow();
  expect(() => store.recordRun({ ...run, startedAt: "yesterday" })).toThrow();
  expect(() => store.patchSettings("one", { pinnedMessageId: -1 })).toThrow();
  writeFileSync(path, "broken");
  expect(() => makeOperationsStore(path)).toThrow("operazioni");
  expect(readFileSync(path, "utf8")).toBe("broken");
});

test("stores only known fields and never a supplied prompt", () => {
  const path = temporary();
  const store = makeOperationsStore(path);
  store.recordRun({ ...run, prompt: "private prompt" } as typeof run);
  expect(readFileSync(path, "utf8")).not.toContain("private prompt");
});

test("Italian statistics distinguish unavailable and partly reported costs", () => {
  const store = makeOperationsStore(temporary());
  store.recordRun(run);
  expect(formatStats(store.stats())).toContain("non disponibile");
  store.recordRun({ ...run, runId: "run-2", costUsd: 0.5 });
  expect(formatStats(store.stats())).toContain("1 su 2");
  expect(formatStats(store.stats())).toContain("USD");
});

test("two store handles preserve each other's settings and runs", () => {
  const path = temporary();
  const first = makeOperationsStore(path);
  const second = makeOperationsStore(path);
  first.patchSettings("one", { approvalPolicy: "ask" });
  second.recordRun(run);
  expect(first.stats().runs).toBe(1);
  expect(second.getSettings("one").approvalPolicy).toBe("ask");
});

test("calendar day ranges follow Rome summer time and 23/25-hour transitions", () => {
  expect(calendarDayRange("2026-09-14")).toEqual({
    since: "2026-09-13T22:00:00.000Z",
    until: "2026-09-14T22:00:00.000Z",
  });
  for (const [date, hours] of [
    ["2026-03-29", 23],
    ["2026-10-25", 25],
  ] as const) {
    const range = calendarDayRange(date);
    expect(Date.parse(range.until) - Date.parse(range.since)).toBe(
      hours * 3_600_000
    );
  }
  expect(calendarDayRange("2024-02-29", "UTC").since).toBe(
    "2024-02-29T00:00:00.000Z"
  );
});

test("calendar range rejects impossible dates, unknown zones and skipped days", () => {
  for (const date of ["2026-02-29", "2026-04-31", "2026-2-01", "tomorrow"]) {
    expect(() => calendarDayRange(date)).toThrow();
  }
  expect(() => calendarDayRange("2026-09-14", "Invalid/Zone")).toThrow();
  expect(() => calendarDayRange("2011-12-30", "Pacific/Apia")).toThrow();
});

test("stats calendar filter includes start and excludes the next midnight", () => {
  const store = makeOperationsStore(temporary());
  const range = {
    since: "2026-09-13T22:00:00.000Z",
    until: "2026-09-14T22:00:00.000Z",
  };
  for (const [i, startedAt] of [
    "2026-09-13T21:59:59.999Z",
    range.since,
    "2026-09-14T21:59:59.999Z",
    range.until,
  ].entries()) {
    store.recordRun({ ...run, runId: `day-${i}`, startedAt });
  }
  expect(store.stats(run.scopeKey, range.since, range.until).runs).toBe(2);
  expect(store.stats(run.scopeKey, range.since).runs).toBe(3);
  expect(() => store.stats(undefined, range.until, range.since)).toThrow();
});

test("timeouts persist off, custom and inherited settings independently", () => {
  const path = temporary();
  const store = makeOperationsStore(path);
  store.patchSettings("one", { runTimeoutMs: 900_000 });
  expect(makeOperationsStore(path).getSettings("one").runTimeoutMs).toBe(
    900_000
  );
  store.patchSettings("two", { runTimeoutMs: null });
  expect(makeOperationsStore(path).getSettings("two").runTimeoutMs).toBeNull();
  store.patchSettings("one", { approvalPolicy: "ask" });
  expect(store.getSettings("one").runTimeoutMs).toBe(900_000);
  store.patchSettings("one", { runTimeoutMs: undefined });
  expect(store.getSettings("one").runTimeoutMs).toBeUndefined();
  for (const value of [0, -1, Number.NaN, 1.5, 86_400_001]) {
    expect(() => store.patchSettings("one", { runTimeoutMs: value })).toThrow();
  }
});
