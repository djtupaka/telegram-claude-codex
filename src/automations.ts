import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProviderId } from "./agent/types";
import { writeJsonAtomic } from "./atomic-write";

const ISO_ZONE = /T.*(?:Z|[+-]\d{2}:\d{2})$/;
const DAILY_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export type Schedule =
  | { kind: "daily"; time: string; timezone?: string }
  | { kind: "once"; at: string };
export interface AutomationTarget {
  chatId: number;
  effort?: string;
  model?: string;
  project: string;
  provider: ProviderId;
  scopeKey: string;
  threadId?: number;
}
export interface AutomationJob extends AutomationTarget {
  completed?: boolean;
  id: string;
  lastError?: string;
  lastResult?: "running" | "success" | "error" | "cancelled";
  lastRunAt?: string;
  nextRunAt: string;
  prompt: string;
  schedule: Schedule;
}
export type EventSource = "coolify" | "truenas" | "tdarr";
export interface EventSubscription extends AutomationTarget {
  source: EventSource;
}
interface AutomationData {
  jobs: AutomationJob[];
  subscriptions: EventSubscription[];
  version: 1;
}

/** Search UTC minutes: honors IANA DST gaps and never repeats the fall-back hour. */
export function nextScheduledTime(schedule: Schedule, after: number): string {
  if (!Number.isFinite(after)) {
    throw new Error("Data non valida");
  }
  if (schedule.kind === "once") {
    const at = Date.parse(schedule.at);
    if (!(ISO_ZONE.test(schedule.at) && Number.isFinite(at)) || at <= after) {
      throw new Error("Indicare una data futura ISO con fuso orario");
    }
    return new Date(at).toISOString();
  }
  if (!DAILY_TIME.test(schedule.time)) {
    throw new Error("Ora non valida: usare HH:MM");
  }
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: schedule.timezone ?? "Europe/Rome",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  for (
    let minute = Math.floor(after / 60_000) * 60_000 + 60_000;
    minute < after + 3 * 86_400_000;
    minute += 60_000
  ) {
    if (formatter.format(minute) === schedule.time) {
      return new Date(minute).toISOString();
    }
  }
  throw new Error("Impossibile calcolare la prossima esecuzione");
}
function validTarget(raw: unknown): raw is AutomationTarget {
  if (!raw || typeof raw !== "object") {
    return false;
  }
  const target = raw as AutomationTarget;
  return (
    typeof target.scopeKey === "string" &&
    target.scopeKey.length > 0 &&
    Number.isSafeInteger(target.chatId) &&
    (target.threadId === undefined ||
      (Number.isSafeInteger(target.threadId) && target.threadId > 0)) &&
    typeof target.project === "string" &&
    target.project.startsWith("/") &&
    (target.provider === "claude" || target.provider === "codex") &&
    (target.model === undefined || typeof target.model === "string") &&
    (target.effort === undefined || typeof target.effort === "string")
  );
}
function validJob(raw: unknown): raw is AutomationJob {
  if (!validTarget(raw)) {
    return false;
  }
  const job = raw as AutomationJob;
  if (
    typeof job.id !== "string" ||
    !job.id ||
    typeof job.prompt !== "string" ||
    !job.prompt.trim() ||
    job.prompt.length > 12_000 ||
    typeof job.nextRunAt !== "string" ||
    !Number.isFinite(Date.parse(job.nextRunAt)) ||
    !job.schedule
  ) {
    return false;
  }
  try {
    nextScheduledTime(
      job.schedule,
      job.schedule.kind === "once" ? 0 : Date.now()
    );
  } catch {
    return false;
  }
  return job.schedule.kind === "once" || job.schedule.kind === "daily";
}
function validSubscription(raw: unknown): raw is EventSubscription {
  return (
    validTarget(raw) &&
    ["coolify", "truenas", "tdarr"].includes((raw as EventSubscription).source)
  );
}
export function makeAutomationStore(
  path = join(import.meta.dirname, "..", ".data", "automations.json")
) {
  const cancelled = new Set<(id: string) => void>();
  const read = (): AutomationData => {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, jobs: [], subscriptions: [] };
      }
      throw error;
    }
    const data = JSON.parse(raw) as AutomationData;
    if (
      data.version !== 1 ||
      !Array.isArray(data.jobs) ||
      !Array.isArray(data.subscriptions) ||
      !data.jobs.every(validJob) ||
      !data.subscriptions.every(validSubscription)
    ) {
      throw new Error("Archivio automazioni non valido");
    }
    return data;
  };
  const write = (data: AutomationData) => {
    mkdirSync(dirname(path), { recursive: true });
    writeJsonAtomic(path, data);
  };
  return {
    list: (scopeKey?: string) =>
      read().jobs.filter((j) => !scopeKey || j.scopeKey === scopeKey),
    add: (
      input: AutomationTarget & { prompt: string; schedule: Schedule },
      now = Date.now()
    ) => {
      if (
        !input.prompt.trim() ||
        input.prompt.length > 12_000 ||
        !input.project ||
        !input.scopeKey
      ) {
        throw new Error("Programma non valido");
      }
      const data = read();
      if (data.jobs.filter((j) => !j.completed).length >= 100) {
        throw new Error("Limite programmi raggiunto");
      }
      const job: AutomationJob = {
        ...input,
        id: randomUUID(),
        nextRunAt: nextScheduledTime(input.schedule, now),
      };
      data.jobs.push(job);
      write(data);
      return structuredClone(job);
    },
    cancel: (scopeKey: string, id: string) => {
      const data = read();
      const index = data.jobs.findIndex(
        (j) => j.scopeKey === scopeKey && j.id === id
      );
      if (index < 0) {
        return false;
      }
      data.jobs.splice(index, 1);
      write(data);
      for (const listener of cancelled) {
        listener(id);
      }
      return true;
    },
    claim: (id: string, now: number) => {
      const data = read();
      const job = data.jobs.find((j) => j.id === id);
      if (!job || job.completed || Date.parse(job.nextRunAt) > now) {
        return undefined;
      }
      job.lastResult = "running";
      job.lastRunAt = new Date(now).toISOString();
      job.lastError = undefined;
      if (job.schedule.kind === "once") {
        job.completed = true;
      } else {
        // Advance beyond the repeated fall-back hour without skipping a 23-hour spring day.
        job.nextRunAt = nextScheduledTime(
          job.schedule,
          Math.max(now, Date.parse(job.nextRunAt) + 2 * 3_600_000)
        );
      }
      write(data);
      return structuredClone(job);
    },
    finish: (
      id: string,
      result: "success" | "error" | "cancelled",
      error?: unknown
    ) => {
      const data = read();
      const job = data.jobs.find((j) => j.id === id);
      if (!job) {
        return;
      }
      job.lastResult = result;
      if (error !== undefined) {
        job.lastError = (
          error instanceof Error ? error.message : String(error)
        ).slice(0, 1000);
      }
      write(data);
    },
    onCancel: (listener: (id: string) => void) => {
      cancelled.add(listener);
      return () => {
        cancelled.delete(listener);
      };
    },
    subscribe: (input: EventSubscription) => {
      if (!["coolify", "truenas", "tdarr"].includes(input.source)) {
        throw new Error("Sorgente non valida");
      }
      const data = read();
      data.subscriptions = data.subscriptions.filter(
        (s) => s.scopeKey !== input.scopeKey || s.source !== input.source
      );
      if (data.subscriptions.length >= 100) {
        throw new Error("Limite sottoscrizioni raggiunto");
      }
      data.subscriptions.push({ ...input });
      write(data);
    },
    subscriptions: (source?: EventSource) =>
      read().subscriptions.filter((s) => !source || s.source === source),
    unsubscribe: (scopeKey: string, source: EventSource) => {
      const data = read();
      const before = data.subscriptions.length;
      data.subscriptions = data.subscriptions.filter(
        (s) => s.scopeKey !== scopeKey || s.source !== source
      );
      if (data.subscriptions.length === before) {
        return false;
      }
      write(data);
      return true;
    },
  };
}
export type AutomationStore = ReturnType<typeof makeAutomationStore>;
export function makeAutomationScheduler(options: {
  store: AutomationStore;
  run: (job: AutomationJob, signal: AbortSignal) => Promise<void>;
  isBusy?: (scopeKey: string) => boolean;
  onError?: (error: unknown) => void;
  timeoutMs?: number;
  maxConcurrent?: number;
}) {
  const running = new Map<
    string,
    { scopeKey: string; controller: AbortController }
  >();
  let interval: ReturnType<typeof setInterval> | undefined;
  const unsubscribe = options.store.onCancel((id) =>
    running.get(id)?.controller.abort()
  );
  const tick = async (now = Date.now()) => {
    const tasks: Promise<void>[] = [];
    for (const candidate of options.store.list()) {
      if (
        candidate.completed ||
        Date.parse(candidate.nextRunAt) > now ||
        running.size >= (options.maxConcurrent ?? 2) ||
        options.isBusy?.(candidate.scopeKey) ||
        [...running.values()].some((r) => r.scopeKey === candidate.scopeKey)
      ) {
        continue;
      }
      const job = options.store.claim(candidate.id, now);
      if (!job) {
        continue;
      }
      const controller = new AbortController();
      running.set(job.id, { scopeKey: job.scopeKey, controller });
      tasks.push(
        (async () => {
          const timeout = setTimeout(
            () => controller.abort(),
            options.timeoutMs ?? 600_000
          );
          try {
            await options.run(job, controller.signal);
            options.store.finish(
              job.id,
              controller.signal.aborted ? "cancelled" : "success"
            );
          } catch (error) {
            options.store.finish(
              job.id,
              controller.signal.aborted ? "cancelled" : "error",
              error
            );
            options.onError?.(error);
          } finally {
            clearTimeout(timeout);
            running.delete(job.id);
          }
        })()
      );
    }
    await Promise.all(tasks);
  };
  return {
    tick,
    start: () => {
      if (interval) {
        return;
      }
      interval = setInterval(() => {
        tick().catch((error) => options.onError?.(error));
      }, 15_000);
      interval.unref();
    },
    stop: () => {
      if (interval) {
        clearInterval(interval);
      }
      interval = undefined;
      unsubscribe();
      for (const run of running.values()) {
        run.controller.abort();
      }
    },
  };
}
