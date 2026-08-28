import { chmodSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { makeSessionOps } from "../src/agent/session-store";

export interface RotateCodexSessionOptions {
  backupRoot?: string;
  dataDir: string;
  now?: Date;
}

export interface RotateCodexSessionResult {
  activeProject: string;
  backupDir: string;
  cleared: boolean;
}

const backupStamp = (now: Date) => now.toISOString().replace(/[:.]/g, "-");

/**
 * Back up both persistence files, then atomically clear only the active
 * project's Codex mapping. Claude sessions, selections, and historical Codex
 * JSONL transcripts are deliberately outside the mutation set.
 */
export const rotateCodexSession = (
  options: RotateCodexSessionOptions
): RotateCodexSessionResult => {
  const dataDir = resolve(options.dataDir);
  const statePath = join(dataDir, "state.json");
  const sessionsPath = join(dataDir, "sessions.json");
  const parsedState = JSON.parse(readFileSync(statePath, "utf8")) as {
    activeProject?: unknown;
  };
  if (
    typeof parsedState.activeProject !== "string" ||
    parsedState.activeProject.length === 0
  ) {
    throw new Error("state.json has no active project");
  }
  const activeProject = parsedState.activeProject;

  const backupRoot = resolve(
    options.backupRoot ?? join(dataDir, "backups", "session-rotation")
  );
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  chmodSync(backupRoot, 0o700);
  const backupDir = join(
    backupRoot,
    `codex-${backupStamp(options.now ?? new Date())}`
  );
  mkdirSync(backupDir, { mode: 0o700 });
  chmodSync(backupDir, 0o700);

  for (const [source, name] of [
    [statePath, "state.json"],
    [sessionsPath, "sessions.json"],
  ] as const) {
    const target = join(backupDir, name);
    copyFileSync(source, target);
    chmodSync(target, 0o600);
  }

  const sessions = makeSessionOps(sessionsPath);
  const prior = sessions.get(activeProject, "codex");
  sessions.clear(activeProject, "codex");
  if (sessions.get(activeProject, "codex") !== undefined) {
    throw new Error("Codex session rotation verification failed");
  }

  return { activeProject, backupDir, cleared: prior !== undefined };
};

if (import.meta.main) {
  const dataDir = process.argv[2] ?? resolve(import.meta.dir, "..", ".data");
  const result = rotateCodexSession({ dataDir });
  console.log(
    `Codex session ${result.cleared ? "rotated" : "already clear"} for ${basename(result.activeProject)}; backup: ${result.backupDir}`
  );
}
