import {
  closeSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { SessionInfo } from "./types";

const MAX_SESSIONS = 50;
const MAX_HEAD_LINES = 40;
const MAX_HEAD_BYTES = 1024 * 1024;
const MAX_CONTEXT_BYTES = 104_857_600;

export const CODEX_CONTEXT_WARNING =
  "Session warning: Codex context file exceeds 100 MiB; consider /new after the current work phase.";

const codexSessionsDir = () =>
  join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");

/**
 * Resolve a path to its macOS-canonical form so Codex-recorded cwds
 * (`/private/var/...`) and bot project paths (`/var/...`) compare equal.
 * Falls back to the raw string when the path can't be resolved.
 */
const normalizePath = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** Cache of sessionId -> projectPath, populated during listing */
const sessionProjectCache = new Map<string, string>();

/** Look up the project path for a session from cache */
export const getSessionProject = (sessionId: string) =>
  sessionProjectCache.get(sessionId);

/** Clears the session-to-project cache */
export const clearSessionCache = () => {
  sessionProjectCache.clear();
};

/** Strip HTML tags and truncate for display */
const cleanSummary = (raw: string) =>
  raw
    .replace(/<[^>]+>/g, "")
    .trim()
    .slice(0, 100);

/**
 * Read a bounded leading window of a rollout file and cap parsed lines. The
 * 1 MiB window comfortably includes Codex's large session metadata while
 * avoiding whole-file reads for long-running sessions.
 */
const readHeadLines = (filePath: string): string[] => {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(MAX_HEAD_BYTES);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.toString("utf8", 0, bytesRead);
    const lines: string[] = [];
    let from = 0;
    while (lines.length < MAX_HEAD_LINES) {
      const nl = text.indexOf("\n", from);
      if (nl === -1) {
        if (from < text.length) {
          lines.push(text.slice(from));
        }
        break;
      }
      lines.push(text.slice(from, nl));
      from = nl + 1;
    }
    return lines.filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
};

/**
 * Parse a Codex rollout file head into session metadata.
 * Pulls id/cwd/timestamp from `session_meta` and the first user prompt
 * (an `event_msg` with `payload.type === "user_message"`) as the summary.
 */
const parseRolloutHead = (
  filePath: string,
  mtimeMs: number
): SessionInfo | null => {
  const lines = readHeadLines(filePath);

  let sessionId = "";
  let projectPath = "";
  let startedAt = "";
  let summary = "";

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === "session_meta" && obj.payload) {
        sessionId = obj.payload.id ?? sessionId;
        projectPath = obj.payload.cwd ?? projectPath;
        startedAt = obj.payload.timestamp ?? obj.timestamp ?? startedAt;
      } else if (
        !summary &&
        obj.type === "event_msg" &&
        obj.payload?.type === "user_message" &&
        typeof obj.payload.message === "string"
      ) {
        summary = obj.payload.message;
      }
      if (sessionId && projectPath && summary) {
        break;
      }
    } catch {
      // malformed JSONL line; skip and continue scanning
    }
  }

  if (!(sessionId && summary)) {
    return null;
  }

  return {
    sessionId,
    summary: cleanSummary(summary),
    startedAt,
    lastActiveAt: new Date(mtimeMs).toISOString(),
    projectPath,
    projectName: projectPath ? basename(projectPath) : "",
  };
};

/** Recursively collect rollout-*.jsonl files with their mtime, newest first */
const collectRolloutFiles = (limit?: number) => {
  const found: Array<{ path: string; mtime: number }> = [];

  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
      } else if (entry.startsWith("rollout-") && entry.endsWith(".jsonl")) {
        found.push({ path: full, mtime: stat.mtimeMs });
      }
    }
  };

  walk(codexSessionsDir());
  const sorted = found.sort((a, b) => b.mtime - a.mtime);
  return limit === undefined ? sorted : sorted.slice(0, limit * 2);
};

const rolloutSessionId = (filePath: string): string | undefined => {
  for (const line of readHeadLines(filePath)) {
    try {
      const entry = JSON.parse(line) as {
        payload?: { id?: unknown };
        type?: unknown;
      };
      if (entry.type === "session_meta") {
        return typeof entry.payload?.id === "string"
          ? entry.payload.id
          : undefined;
      }
    } catch {
      // Ignore malformed head lines and continue to the session metadata.
    }
  }
  return undefined;
};

/** Resolve exact rollout metadata for a persisted active Codex session. */
export const getCodexSessionFileInfo = (
  sessionId: string
): { path: string; sizeBytes: number } | undefined => {
  if (!sessionId) {
    return undefined;
  }
  for (const file of collectRolloutFiles()) {
    if (rolloutSessionId(file.path) !== sessionId) {
      continue;
    }
    try {
      return { path: file.path, sizeBytes: statSync(file.path).size };
    } catch {
      return undefined;
    }
  }
  return undefined;
};

/** Read-only warning lookup for the exact persisted Codex session id. */
export const getCodexContextWarning = (
  sessionId: string
): string | undefined => {
  const info = getCodexSessionFileInfo(sessionId);
  return info && info.sizeBytes > MAX_CONTEXT_BYTES
    ? CODEX_CONTEXT_WARNING
    : undefined;
};

/** List recent Codex sessions across all projects, newest first */
export const listAllSessions = (): SessionInfo[] => {
  const files = collectRolloutFiles(MAX_SESSIONS);

  const sessions: SessionInfo[] = [];
  for (const { path, mtime } of files) {
    const info = parseRolloutHead(path, mtime);
    if (info) {
      sessions.push(info);
    }
    if (sessions.length >= MAX_SESSIONS) {
      break;
    }
  }

  for (const s of sessions) {
    if (s.projectPath) {
      sessionProjectCache.set(s.sessionId, normalizePath(s.projectPath));
    }
  }
  return sessions;
};

/** List recent Codex sessions for a specific project (filtered by canonicalized cwd) */
export const listSessions = (projectPath: string): SessionInfo[] => {
  const target = normalizePath(projectPath);
  return listAllSessions().filter(
    (s) => s.projectPath && normalizePath(s.projectPath) === target
  );
};
