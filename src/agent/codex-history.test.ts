import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_CONTEXT_WARNING,
  getCodexContextWarning,
  getCodexSessionFileInfo,
} from "./codex-history";

let codexHome: string;
let previousCodexHome: string | undefined;

beforeEach(() => {
  codexHome = mkdtempSync(join(tmpdir(), "codex-history-"));
  previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
});

afterEach(() => {
  if (previousCodexHome === undefined) {
    Reflect.deleteProperty(process.env, "CODEX_HOME");
  } else {
    process.env.CODEX_HOME = previousCodexHome;
  }
  rmSync(codexHome, { force: true, recursive: true });
});

const rollout = (name: string, sessionId: string, suffix = "") => {
  const dir = join(codexHome, "sessions", "2026", "09", "09");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  const contents = `${JSON.stringify({
    type: "session_meta",
    payload: { id: sessionId, cwd: "/project" },
  })}\n${suffix}`;
  writeFileSync(path, contents);
  return { contents, path };
};

describe("getCodexSessionFileInfo", () => {
  test("selects the exact active rollout and returns its size read-only", () => {
    rollout("rollout-active-copy.jsonl", "session-123-copy", "newer");
    const active = rollout(
      "rollout-unrelated-name.jsonl",
      "session-123",
      "data"
    );
    const before = statSync(active.path);

    const info = getCodexSessionFileInfo("session-123");

    expect(info).toEqual({
      path: active.path,
      sizeBytes: Buffer.byteLength(active.contents),
    });
    expect(readFileSync(active.path, "utf8")).toBe(active.contents);
    expect(statSync(active.path).mtimeMs).toBe(before.mtimeMs);
  });

  test("returns undefined when no rollout metadata has the exact id", () => {
    rollout("rollout-near-match.jsonl", "session-123-copy");
    expect(getCodexSessionFileInfo("session-123")).toBeUndefined();
  });
});

describe("getCodexContextWarning", () => {
  test("warns only above 100 MiB for the exact session", () => {
    const active = rollout("rollout-large.jsonl", "large-session");
    truncateSync(active.path, 104_857_601);
    rollout("rollout-small.jsonl", "small-session");

    expect(getCodexContextWarning("large-session")).toBe(CODEX_CONTEXT_WARNING);
    expect(getCodexContextWarning("small-session")).toBeUndefined();
    expect(getCodexContextWarning("missing-session")).toBeUndefined();
  });

  test("does not warn at exactly 100 MiB", () => {
    const active = rollout("rollout-limit.jsonl", "limit-session");
    truncateSync(active.path, 104_857_600);
    expect(getCodexContextWarning("limit-session")).toBeUndefined();
  });
});
