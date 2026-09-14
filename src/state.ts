import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import {
  importLegacySessions,
  type LegacySessions,
} from "./agent/session-store";
import type { ProviderId } from "./agent/types";
import { writeJsonAtomic } from "./atomic-write";
import { runtime } from "./runtime";

const STATE_VERSION = 2 as const;
const ASTRA_MODEL = "gpt-6-astra";
const CLAUDE_MODEL_MIGRATIONS: Readonly<Record<string, string>> = {
  fable: "claude-fable-5-1",
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5-20251001",
};

/** Per-provider selection map (model id or effort id, keyed by provider). */
type ProviderChoices = Partial<Record<ProviderId, string>>;

interface PersistedState {
  activeProject: string;
  activeProvider: ProviderId;
  efforts?: ProviderChoices;
  models?: ProviderChoices;
  version?: number;
}

interface BotState {
  activeProject: string;
  activeProvider: ProviderId;
  efforts: ProviderChoices;
  models: ProviderChoices;
  /**
   * Forum-topic scope key (`t:<chatId>:<threadId>`). When set, persistence goes
   * to the topic record in topics.json instead of the global state.json.
   */
  scopeKey?: string;
}

const DATA_DIR = join(import.meta.dirname, "..", ".data");
const STATE_FILE = join(DATA_DIR, "state.json");
const TOPICS_FILE = join(DATA_DIR, "topics.json");

/** One forum topic = one independent session scope (project, provider, choices). */
export interface TopicRecord {
  activeProject: string;
  activeProvider: ProviderId;
  chatId: number;
  createdAt: string;
  efforts: ProviderChoices;
  models: ProviderChoices;
  name: string;
  threadId: number;
}

interface TopicsFile {
  topics: Record<string, TopicRecord>;
  version: 1;
}

const isProviderId = (v: unknown): v is ProviderId =>
  v === "claude" || v === "codex";

/** Keep only well-formed topic records; a malformed file never blocks boot. */
const coerceTopics = (raw: unknown): Record<string, TopicRecord> => {
  const out: Record<string, TopicRecord> = {};
  const topics =
    raw && typeof raw === "object"
      ? (raw as { topics?: unknown }).topics
      : undefined;
  if (!topics || typeof topics !== "object") {
    return out;
  }
  for (const [key, value] of Object.entries(
    topics as Record<string, unknown>
  )) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const r = value as Record<string, unknown>;
    if (
      typeof r.chatId !== "number" ||
      typeof r.threadId !== "number" ||
      typeof r.activeProject !== "string" ||
      !isProviderId(r.activeProvider)
    ) {
      continue;
    }
    out[key] = {
      activeProject: r.activeProject,
      activeProvider: r.activeProvider,
      chatId: r.chatId,
      createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
      efforts: coerceChoices(r.efforts),
      models: coerceChoices(r.models),
      name: typeof r.name === "string" ? r.name : "",
      threadId: r.threadId,
    };
  }
  return out;
};

/**
 * Topic persistence, separate from state.json so the existing global state
 * (and its corruption handling) is untouched. Path-injectable for tests.
 */
export const makeTopicOps = (path = TOPICS_FILE) => {
  const read = (): Record<string, TopicRecord> => {
    try {
      return coerceTopics(JSON.parse(readFileSync(path, "utf-8")) as unknown);
    } catch {
      return {};
    }
  };
  const write = (topics: Record<string, TopicRecord>) => {
    mkdirSync(dirname(path), { recursive: true });
    const data: TopicsFile = { version: 1, topics };
    writeJsonAtomic(path, data);
  };
  return {
    list: () => read(),
    get: (key: string): TopicRecord | undefined => read()[key],
    upsert: (key: string, record: TopicRecord) => {
      const topics = read();
      topics[key] = record;
      write(topics);
    },
    patch: (key: string, partial: Partial<TopicRecord>) => {
      const topics = read();
      const current = topics[key];
      if (!current) {
        return false;
      }
      topics[key] = { ...current, ...partial };
      write(topics);
      return true;
    },
    remove: (key: string) => {
      const topics = read();
      if (!(key in topics)) {
        return false;
      }
      delete topics[key];
      write(topics);
      return true;
    },
  };
};

export const topicOps = makeTopicOps();
export const DEFAULT_PROVIDER: ProviderId = "codex";

/**
 * Best-effort operational event. Bridged through the runtime so it flows to the
 * phase-1 logger; a logging fault must never abort a state read or write, so the
 * whole call is guarded.
 */
const logEvent = (fields: Record<string, unknown>) => {
  try {
    runtime.runFork(Effect.logInfo("state").pipe(Effect.annotateLogs(fields)));
  } catch {
    // best-effort: never let observability break persistence
  }
};

/** Detect the old flat-session shape (no activeProvider, or a string session value). */
function isOldShape(parsed: unknown) {
  if (!parsed || typeof parsed !== "object") {
    return false;
  }
  const obj = parsed as Record<string, unknown>;
  if (!("activeProvider" in obj)) {
    return true;
  }
  const sessions = obj.sessions;
  if (sessions && typeof sessions === "object") {
    for (const value of Object.values(sessions)) {
      if (typeof value === "string") {
        return true;
      }
    }
  }
  return false;
}

/** Extract legacy session ids from either the old flat shape or the prior nested shape. */
function buildLegacySessions(parsed: unknown): LegacySessions {
  const sessions: LegacySessions = { claude: new Map(), codex: new Map() };
  if (isOldShape(parsed)) {
    const oldSessions =
      (parsed as { sessions?: Record<string, string> }).sessions ?? {};
    sessions.claude = new Map(Object.entries(oldSessions));
    return sessions;
  }
  const nested = parsed as {
    sessions?: Partial<Record<ProviderId, Record<string, string>>>;
  };
  sessions.claude = new Map(Object.entries(nested.sessions?.claude ?? {}));
  sessions.codex = new Map(Object.entries(nested.sessions?.codex ?? {}));
  return sessions;
}

/** Parse + normalize the persisted state, throwing only on genuine corruption. */
export interface ParsedState {
  activeProject: string;
  activeProvider: ProviderId;
  efforts: ProviderChoices;
  legacySessions: LegacySessions;
  models: ProviderChoices;
  needsPersist: boolean;
}

function parseState(text: string): ParsedState {
  const parsed = JSON.parse(text) as unknown;

  const activeProjectRaw =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>).activeProject
      : undefined;
  const activeProject =
    typeof activeProjectRaw === "string" && existsSync(activeProjectRaw)
      ? activeProjectRaw
      : "";

  const activeProviderRaw =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>).activeProvider
      : undefined;
  const activeProvider: ProviderId =
    activeProviderRaw === "claude" || activeProviderRaw === "codex"
      ? activeProviderRaw
      : DEFAULT_PROVIDER;

  const record =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  const sourceVersion = typeof record.version === "number" ? record.version : 0;
  const models = coerceChoices(record.models);
  if (
    sourceVersion < STATE_VERSION &&
    (!models.codex ||
      models.codex === "default" ||
      models.codex === "gpt-5.6-sol")
  ) {
    models.codex = ASTRA_MODEL;
  }
  if (sourceVersion < STATE_VERSION && models.claude) {
    models.claude = CLAUDE_MODEL_MIGRATIONS[models.claude] ?? models.claude;
  }

  return {
    activeProvider,
    activeProject,
    models,
    efforts: coerceChoices(record.efforts),
    legacySessions: buildLegacySessions(parsed),
    needsPersist: sourceVersion < STATE_VERSION,
  };
}

/** Test-only access to the exact pure parser used by production state loading. */
export const parseStateForTest = parseState;

/** Keep only string-valued `claude`/`codex` keys from an untrusted choices map. */
function coerceChoices(raw: unknown): ProviderChoices {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const out: ProviderChoices = {};
  for (const id of ["claude", "codex"] as const) {
    const value = (raw as Record<string, unknown>)[id];
    if (typeof value === "string") {
      out[id] = value;
    }
  }
  return out;
}

/** Discriminated result of reading the raw state file (no side effects beyond corrupt-preservation). */
type StateLoad =
  | { status: "missing" }
  | { status: "corrupt"; preservedTo: string; errorClass: string }
  | ({ status: "ok" } & ReturnType<typeof parseState>);

/**
 * Read + classify the state file, distinguishing a legitimate first run
 * (`missing`) from genuine corruption. A parse/shape fault preserves the bad
 * file as `state.json.corrupt-<ts>` (best-effort — a read-only `.data` must not
 * block boot) and reports `corrupt` so the caller fails open to defaults —
 * never a silent total wipe. Pure of runtime logging + legacy import so it is
 * directly unit-testable against a temp dir. A real IO fault (not ENOENT) is
 * rethrown rather than masked as empty state.
 */
export function readStateFile(stateFile = STATE_FILE): StateLoad {
  let text: string;
  try {
    text = readFileSync(stateFile, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing" };
    }
    throw e; // real IO fault — surface, don't mask as empty state
  }

  try {
    return { status: "ok", ...parseState(text) };
  } catch (err) {
    // Only a genuine parse/shape fault is corruption. Preserve the bad file.
    const preservedTo = `${stateFile}.corrupt-${Date.now()}`;
    try {
      renameSync(stateFile, preservedTo);
    } catch {
      // keep booting even if preservation fails (read-only / full disk)
    }
    return { status: "corrupt", preservedTo, errorClass: (err as Error).name };
  }
}

/**
 * Load persisted state, distinguishing a legitimate first run from corruption.
 * A missing/corrupt file returns null so the bot still starts with defaults;
 * corruption is preserved (see readStateFile). Legacy inline sessions are
 * imported once into the SessionStore on a successful read.
 */
export function loadPersistedState() {
  const loaded = readStateFile();

  if (loaded.status === "missing") {
    logEvent({ event: "state.load", result: "missing" });
    return null;
  }
  if (loaded.status === "corrupt") {
    logEvent({
      event: "state.load",
      result: "corrupt",
      preservedTo: loaded.preservedTo,
      errorClass: loaded.errorClass,
    });
    return null; // fail open: boot with defaults, but the data is preserved
  }

  // The legacy import writes a SECOND file (sessions.json); a transient write
  // fault there must never be mistaken for state.json corruption, so it is
  // best-effort and outside the corruption guard above.
  try {
    importLegacySessions(loaded.legacySessions);
  } catch (err) {
    logEvent({
      event: "state.load",
      result: "legacy-import-failed",
      errorClass: (err as Error).name,
    });
  }
  if (loaded.needsPersist) {
    persistState({
      activeProvider: loaded.activeProvider,
      activeProject: loaded.activeProject,
      models: loaded.models,
      efforts: loaded.efforts,
    });
  }
  logEvent({ event: "state.load", result: "ok" });
  return {
    activeProvider: loaded.activeProvider,
    activeProject: loaded.activeProject,
    models: loaded.models,
    efforts: loaded.efforts,
  };
}

/** Persist active project, provider, and per-provider model/effort choices atomically. */
function persistState(state: BotState) {
  if (state.scopeKey) {
    // Topic scope: never touch the global (private-chat) state.
    const ok = topicOps.patch(state.scopeKey, {
      activeProject: state.activeProject,
      activeProvider: state.activeProvider,
      models: state.models,
      efforts: state.efforts,
    });
    logEvent({ event: "topic.save", key: state.scopeKey, ok });
    return;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  const data: PersistedState = {
    version: STATE_VERSION,
    activeProvider: state.activeProvider,
    activeProject: state.activeProject,
    models: state.models,
    efforts: state.efforts,
  };
  const { bytes, durationMs } = writeJsonAtomic(STATE_FILE, data);
  logEvent({ event: "state.save", bytes, durationMs });
}

const saveState = persistState;

/** Set active project and persist. */
export function setActiveProject(state: BotState, path: string) {
  state.activeProject = path;
  saveState(state);
}

/** Set the active provider and persist. */
export function setActiveProvider(state: BotState, providerId: ProviderId) {
  state.activeProvider = providerId;
  saveState(state);
}

/** Set the model for a provider and persist. */
export function setModel(state: BotState, provider: ProviderId, model: string) {
  state.models[provider] = model;
  saveState(state);
}

/** Set the reasoning-effort level for a provider and persist. */
export function setEffort(
  state: BotState,
  provider: ProviderId,
  effort: string
) {
  state.efforts[provider] = effort;
  saveState(state);
}
