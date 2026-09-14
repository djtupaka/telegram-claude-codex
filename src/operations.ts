import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ProviderId } from "./agent/types";
export interface ScopeSettings {
  approvalPolicy: "automatic" | "ask";
  pinnedMessageId?: number;
  /** Undefined inherits the global default; null disables the whole-run timeout. */
  runTimeoutMs?: number | null;
}
export interface OperationRun {
  costUsd: number | null;
  durationMs: number;
  outcome: "done" | "interrupted" | "timeout" | "errored" | "at_capacity";
  project: string;
  provider: ProviderId;
  runId: string;
  scopeKey: string;
  startedAt: string;
  totalTokens: number | null;
}
export interface OperationsStats {
  costReportedRuns: number;
  costUsd: number | null;
  durationMs: number;
  outcomes: Record<OperationRun["outcome"], number>;
  runs: number;
  totalTokens: number | null;
}

interface OperationsFile {
  runs: OperationRun[];
  settings: Record<string, ScopeSettings>;
  version: 1;
}
const OUTCOMES = [
  "done",
  "interrupted",
  "timeout",
  "errored",
  "at_capacity",
] as const;
const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const DEFAULT_PATH = join(import.meta.dir, "..", ".data", "operations.json");
const MILLISECONDS_PER_SECOND = 1000;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isNonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const isDate = (value: unknown): value is string =>
  typeof value === "string" &&
  ISO_DATE.test(value) &&
  Number.isFinite(Date.parse(value));
function invalid(): never {
  throw new Error("Archivio operazioni o valori non validi; dati conservati.");
}
function settingsOf(value: unknown): ScopeSettings {
  if (
    !isRecord(value) ||
    (value.approvalPolicy !== "automatic" && value.approvalPolicy !== "ask")
  ) {
    return invalid();
  }
  if (
    value.pinnedMessageId !== undefined &&
    !(
      typeof value.pinnedMessageId === "number" &&
      Number.isSafeInteger(value.pinnedMessageId) &&
      value.pinnedMessageId > 0
    )
  ) {
    return invalid();
  }
  if (
    value.runTimeoutMs !== undefined &&
    value.runTimeoutMs !== null &&
    !(
      typeof value.runTimeoutMs === "number" &&
      Number.isSafeInteger(value.runTimeoutMs) &&
      value.runTimeoutMs > 0 &&
      value.runTimeoutMs <= 86_400_000
    )
  ) {
    return invalid();
  }
  return {
    approvalPolicy: value.approvalPolicy,
    ...(value.runTimeoutMs !== undefined
      ? { runTimeoutMs: value.runTimeoutMs as number | null }
      : {}),
    ...(typeof value.pinnedMessageId === "number"
      ? { pinnedMessageId: value.pinnedMessageId }
      : {}),
  };
}
function runOf(value: unknown): OperationRun {
  if (
    !(
      isRecord(value) &&
      isText(value.scopeKey) &&
      isText(value.project) &&
      isText(value.runId) &&
      isDate(value.startedAt)
    ) ||
    (value.provider !== "codex" && value.provider !== "claude") ||
    !OUTCOMES.includes(value.outcome as OperationRun["outcome"]) ||
    !isNonnegative(value.durationMs)
  ) {
    return invalid();
  }
  if (
    (value.costUsd !== null && !isNonnegative(value.costUsd)) ||
    (value.totalTokens !== null &&
      !(
        isNonnegative(value.totalTokens) &&
        Number.isSafeInteger(value.totalTokens)
      ))
  ) {
    return invalid();
  }
  return {
    scopeKey: value.scopeKey,
    project: value.project,
    provider: value.provider,
    runId: value.runId,
    startedAt: value.startedAt,
    durationMs: value.durationMs,
    costUsd: value.costUsd as number | null,
    totalTokens: value.totalTokens as number | null,
    outcome: value.outcome as OperationRun["outcome"],
  };
}
function readStore(path: string): OperationsFile {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, settings: {}, runs: [] };
    }
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return invalid();
  }
  if (
    !isRecord(raw) ||
    raw.version !== 1 ||
    !isRecord(raw.settings) ||
    !Array.isArray(raw.runs)
  ) {
    return invalid();
  }
  const settings = Object.fromEntries(
    Object.entries(raw.settings).map(([key, value]) => {
      if (!isText(key)) {
        return invalid();
      }
      return [key, settingsOf(value)];
    })
  );
  const runs = raw.runs.map(runOf);
  if (new Set(runs.map((run) => run.runId)).size !== runs.length) {
    return invalid();
  }
  return { version: 1, settings, runs };
}
function persist(path: string, data: OperationsFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(data, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
const scopeSettings = (
  data: OperationsFile,
  scopeKey: string
): ScopeSettings =>
  Object.hasOwn(data.settings, scopeKey)
    ? settingsOf(data.settings[scopeKey])
    : { approvalPolicy: "automatic" };

const matchesFilter = (
  run: OperationRun,
  scopeKey?: string,
  since?: string,
  until?: string
) =>
  (scopeKey === undefined || run.scopeKey === scopeKey) &&
  (since === undefined || Date.parse(run.startedAt) >= Date.parse(since)) &&
  (until === undefined || Date.parse(run.startedAt) < Date.parse(until));

/** Synchronous transactions suit the bot's single process; reload before every mutation. */
export function makeOperationsStore(path = DEFAULT_PATH) {
  readStore(path);
  return {
    getSettings(scopeKey: string): ScopeSettings {
      if (!isText(scopeKey)) {
        return invalid();
      }
      return scopeSettings(readStore(path), scopeKey);
    },
    patchSettings(
      scopeKey: string,
      patch: Partial<ScopeSettings>
    ): ScopeSettings {
      if (!(isText(scopeKey) && isRecord(patch))) {
        return invalid();
      }
      const data = readStore(path);
      const next = settingsOf({ ...scopeSettings(data, scopeKey), ...patch });
      data.settings = { ...data.settings, [scopeKey]: next };
      persist(path, data);
      return { ...next };
    },
    recordRun(value: OperationRun): boolean {
      const run = runOf(value);
      const data = readStore(path);
      if (data.runs.some((previous) => previous.runId === run.runId)) {
        return false;
      }
      data.runs.push(run);
      persist(path, data);
      return true;
    },
    stats(scopeKey?: string, since?: string, until?: string): OperationsStats {
      if (
        (scopeKey !== undefined && !isText(scopeKey)) ||
        (since !== undefined && !isDate(since)) ||
        (until !== undefined && !isDate(until)) ||
        (since !== undefined &&
          until !== undefined &&
          Date.parse(since) >= Date.parse(until))
      ) {
        return invalid();
      }
      const result: OperationsStats = {
        runs: 0,
        durationMs: 0,
        costUsd: null,
        costReportedRuns: 0,
        totalTokens: null,
        outcomes: {
          done: 0,
          interrupted: 0,
          timeout: 0,
          errored: 0,
          at_capacity: 0,
        },
      };
      for (const run of readStore(path).runs) {
        if (!matchesFilter(run, scopeKey, since, until)) {
          continue;
        }
        result.runs += 1;
        result.durationMs += run.durationMs;
        result.outcomes[run.outcome] += 1;
        if (run.costUsd !== null) {
          result.costUsd = (result.costUsd ?? 0) + run.costUsd;
          result.costReportedRuns += 1;
        }
        if (run.totalTokens !== null) {
          result.totalTokens = (result.totalTokens ?? 0) + run.totalTokens;
        }
      }
      return result;
    },
  };
}

export function formatStats(stats: OperationsStats): string {
  const cost =
    stats.costUsd === null
      ? "non disponibile"
      : `${stats.costUsd.toFixed(4)} USD (riportato per ${stats.costReportedRuns} su ${stats.runs} esecuzioni)`;
  return [
    `Esecuzioni: ${stats.runs}`,
    `Durata complessiva: ${(stats.durationMs / MILLISECONDS_PER_SECOND).toFixed(1)} s`,
    `Costo comunicato dai provider: ${cost}`,
    `Token comunicati dai provider: ${stats.totalTokens ?? "non disponibile"}`,
    `Completate: ${stats.outcomes.done}; interrotte: ${stats.outcomes.interrupted}; scadute: ${stats.outcomes.timeout}; errori: ${stats.outcomes.errored}; capacità esaurita: ${stats.outcomes.at_capacity}`,
  ].join("\n");
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const SEARCH_MARGIN_MS = 2 * DAY_MS;
const YEAR_KEY_MULTIPLIER = 10_000;
const MONTH_KEY_MULTIPLIER = 100;
const dateKey = (year: number, month: number, day: number) =>
  year * YEAR_KEY_MULTIPLIER + month * MONTH_KEY_MULTIPLIER + day;
const utcDateKey = (date: Date) =>
  dateKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());

/** Locate civil-day boundaries, including midnight offset transitions and skipped dates. */
export function calendarDayRange(
  date: string,
  timezone = "Europe/Rome"
): { since: string; until: string } {
  const midnight = Date.parse(`${date}T00:00:00.000Z`);
  if (
    !(CALENDAR_DATE.test(date) && Number.isFinite(midnight)) ||
    new Date(midnight).toISOString().slice(0, 10) !== date ||
    date.startsWith("0000")
  ) {
    throw new Error(
      "Data non valida: usare un giorno reale nel formato YYYY-MM-DD."
    );
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const localDateKey = (at: number) => {
    const parts = Object.fromEntries(
      formatter.formatToParts(at).map((part) => [part.type, part.value])
    );
    return dateKey(Number(parts.year), Number(parts.month), Number(parts.day));
  };
  const boundary = (nominal: number) => {
    const wanted = utcDateKey(new Date(nominal));
    let low = nominal - SEARCH_MARGIN_MS;
    let high = nominal + SEARCH_MARGIN_MS;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (localDateKey(middle) < wanted) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  };
  const since = boundary(midnight);
  if (localDateKey(since) !== utcDateKey(new Date(midnight))) {
    throw new Error("Il giorno indicato non esiste nel fuso orario scelto.");
  }
  return {
    since: new Date(since).toISOString(),
    until: new Date(boundary(midnight + DAY_MS)).toISOString(),
  };
}
