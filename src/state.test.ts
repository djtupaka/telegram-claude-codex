import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStateForTest, readStateFile } from "./state";

let dir: string;
let statePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "state-"));
  statePath = join(dir, "state.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readStateFile", () => {
  test("a missing file is a legitimate first run, not corruption", () => {
    const loaded = readStateFile(statePath);
    expect(loaded.status).toBe("missing");
    // nothing was created or preserved
    expect(readdirSync(dir)).toEqual([]);
  });

  test("valid state round-trips provider and an existing project path", () => {
    // activeProject must exist on disk to survive parseState's existence check.
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        activeProvider: "codex",
        activeProject: dir,
        sessions: { claude: { [dir]: "c-1" }, codex: { [dir]: "x-1" } },
      })
    );
    const loaded = readStateFile(statePath);
    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok") {
      expect(loaded.activeProvider).toBe("codex");
      expect(loaded.activeProject).toBe(dir);
      expect(loaded.legacySessions.claude.get(dir)).toBe("c-1");
      expect(loaded.legacySessions.codex.get(dir)).toBe("x-1");
    }
  });

  test("a non-existent activeProject and invalid provider default to Codex", () => {
    writeFileSync(
      statePath,
      JSON.stringify({ activeProject: "/no/such/dir", activeProvider: "bogus" })
    );
    const loaded = readStateFile(statePath);
    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok") {
      expect(loaded.activeProject).toBe("");
      expect(loaded.activeProvider).toBe("codex");
    }
  });

  test("an explicitly persisted Claude provider is preserved", () => {
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 2,
        activeProject: dir,
        activeProvider: "claude",
      })
    );
    const loaded = readStateFile(statePath);
    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok") {
      expect(loaded.activeProvider).toBe("claude");
    }
  });

  test("migrates the old flat session shape into legacySessions.claude", () => {
    // Old shape: no activeProvider, sessions is a flat { <proj>: <id> } map.
    writeFileSync(statePath, JSON.stringify({ sessions: { "/p": "c-1" } }));
    const loaded = readStateFile(statePath);
    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok") {
      expect(loaded.activeProvider).toBe("codex");
      expect(loaded.legacySessions.claude.get("/p")).toBe("c-1");
      expect(loaded.legacySessions.codex.size).toBe(0);
    }
  });

  test("model/effort choices round-trip, ignoring non-string entries", () => {
    writeFileSync(
      statePath,
      JSON.stringify({
        activeProvider: "claude",
        activeProject: dir,
        models: { claude: "opus", codex: 42 },
        efforts: { codex: "high" },
      })
    );
    const loaded = readStateFile(statePath);
    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok") {
      expect(loaded.models.claude).toBe("claude-opus-5");
      expect(loaded.models.codex).toBe("gpt-6-astra");
      expect(loaded.efforts.codex).toBe("high");
      expect(loaded.efforts.claude).toBeUndefined();
    }
  });

  test("a state file without models/efforts loads them as empty maps", () => {
    writeFileSync(
      statePath,
      JSON.stringify({ activeProvider: "claude", activeProject: dir })
    );
    const loaded = readStateFile(statePath);
    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok") {
      expect(loaded.models).toEqual({ codex: "gpt-6-astra" });
      expect(loaded.efforts).toEqual({});
    }
  });

  test("a real IO fault (not ENOENT) is rethrown, never masked as empty", () => {
    // Reading a directory as a file surfaces EISDIR — a genuine fault the loader
    // must surface rather than silently treat as missing/corrupt state.
    expect(() => readStateFile(dir)).toThrow();
  });

  test("corrupt JSON is preserved, not silently wiped", () => {
    writeFileSync(statePath, "{ not json");
    const loaded = readStateFile(statePath);
    expect(loaded.status).toBe("corrupt");
    if (loaded.status === "corrupt") {
      expect(loaded.errorClass).toBe("SyntaxError");
      expect(loaded.preservedTo.startsWith(`${statePath}.corrupt-`)).toBe(true);
    }
    // the bad file was renamed aside — a corrupt copy exists, original is gone
    const files = readdirSync(dir);
    expect(files.some((f) => f.startsWith("state.json.corrupt-"))).toBe(true);
    expect(files).not.toContain("state.json");
  });
});

describe("state version migration", () => {
  test("a fresh state payload defaults to Codex and Astra", () => {
    const parsed = parseStateForTest("{}");
    expect(parsed.activeProvider).toBe("codex");
    expect(parsed.models.codex).toBe("gpt-6-astra");
  });

  test("version-1 Sol choice migrates once to Astra", () => {
    const parsed = parseStateForTest(
      JSON.stringify({
        version: 1,
        activeProvider: "codex",
        activeProject: "",
        models: { codex: "gpt-5.6-sol" },
      })
    );
    expect(parsed.models.codex).toBe("gpt-6-astra");
    expect(parsed.needsPersist).toBe(true);
  });

  test("version-2 explicit Sol choice is preserved", () => {
    const parsed = parseStateForTest(
      JSON.stringify({
        version: 2,
        activeProvider: "codex",
        activeProject: "",
        models: { codex: "gpt-5.6-sol" },
      })
    );
    expect(parsed.models.codex).toBe("gpt-5.6-sol");
  });

  test.each([
    undefined,
    "default",
  ])("version-1 Codex choice %p migrates to Astra", (codexModel) => {
    const parsed = parseStateForTest(
      JSON.stringify({
        version: 1,
        activeProvider: "codex",
        activeProject: "",
        models: codexModel === undefined ? {} : { codex: codexModel },
      })
    );
    expect(parsed.models.codex).toBe("gpt-6-astra");
    expect(parsed.needsPersist).toBe(true);
  });

  test.each([
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ])("version-1 explicit Codex choice %s is preserved", (codexModel) => {
    const parsed = parseStateForTest(
      JSON.stringify({
        version: 1,
        activeProvider: "codex",
        activeProject: "",
        models: { codex: codexModel },
      })
    );
    expect(parsed.models.codex).toBe(codexModel);
    expect(parsed.needsPersist).toBe(true);
  });

  test.each([
    ["fable", "claude-fable-5-1"],
    ["opus", "claude-opus-5"],
    ["sonnet", "claude-sonnet-5"],
    ["haiku", "claude-haiku-4-5-20251001"],
  ])("version-1 Claude alias %s migrates to %s", (legacy, current) => {
    const parsed = parseStateForTest(
      JSON.stringify({
        version: 1,
        activeProvider: "claude",
        activeProject: "",
        models: { claude: legacy },
      })
    );
    expect(parsed.models.claude).toBe(current);
    expect(parsed.activeProvider).toBe("claude");
    expect(parsed.needsPersist).toBe(true);
  });

  test.each([
    "default",
    "claude-fable-5-1",
    "claude-opus-5",
  ])("version-1 current Claude choice %s is preserved", (model) => {
    const parsed = parseStateForTest(
      JSON.stringify({
        version: 1,
        activeProvider: "claude",
        activeProject: "",
        models: { claude: model },
      })
    );
    expect(parsed.models.claude).toBe(model);
  });
});
