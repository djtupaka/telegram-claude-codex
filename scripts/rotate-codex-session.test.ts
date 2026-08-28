import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotateCodexSession } from "./rotate-codex-session";

let root: string;
let dataDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rotate-codex-"));
  dataDir = join(root, ".data");
  mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("rotateCodexSession", () => {
  test("backs up state/store and clears only Codex for the active project", () => {
    const activeProject = "/srv/projects/premelone";
    const state = {
      version: 1,
      activeProvider: "codex",
      activeProject,
      models: { codex: "gpt-5.6-sol" },
      efforts: { codex: "medium" },
    };
    const sessions = {
      version: 1,
      sessions: {
        [activeProject]: {
          claude: { sessionId: "claude-keep" },
          codex: { sessionId: "codex-clear" },
        },
        "/srv/projects/other": {
          codex: { sessionId: "codex-other-keep" },
        },
      },
    };
    const statePath = join(dataDir, "state.json");
    const sessionsPath = join(dataDir, "sessions.json");
    const stateText = JSON.stringify(state, null, 2);
    writeFileSync(statePath, stateText);
    writeFileSync(sessionsPath, JSON.stringify(sessions, null, 2));
    chmodSync(statePath, 0o644);
    chmodSync(sessionsPath, 0o644);

    const result = rotateCodexSession({
      dataDir,
      backupRoot: join(root, "backups"),
      now: new Date("2026-08-28T12:34:56.000Z"),
    });

    expect(result.activeProject).toBe(activeProject);
    expect(result.cleared).toBe(true);
    expect(statSync(result.backupDir).mode % 0o1000).toBe(0o700);
    for (const name of ["state.json", "sessions.json"]) {
      expect(statSync(join(result.backupDir, name)).mode % 0o1000).toBe(0o600);
    }
    expect(readFileSync(join(result.backupDir, "state.json"), "utf8")).toBe(
      stateText
    );

    const after = JSON.parse(readFileSync(sessionsPath, "utf8"));
    expect(after.sessions[activeProject].codex).toBeUndefined();
    expect(after.sessions[activeProject].claude.sessionId).toBe("claude-keep");
    expect(after.sessions["/srv/projects/other"].codex.sessionId).toBe(
      "codex-other-keep"
    );
    expect(readFileSync(statePath, "utf8")).toBe(stateText);
  });

  test("does not mutate sessions when a complete backup cannot be made", () => {
    const sessionsPath = join(dataDir, "sessions.json");
    const sessionsText = JSON.stringify({
      version: 1,
      sessions: {
        "/srv/projects/premelone": {
          codex: { sessionId: "codex-keep-on-failure" },
        },
      },
    });
    writeFileSync(sessionsPath, sessionsText);

    expect(() =>
      rotateCodexSession({
        dataDir,
        backupRoot: join(root, "backups"),
      })
    ).toThrow();
    expect(readFileSync(sessionsPath, "utf8")).toBe(sessionsText);
  });
});
