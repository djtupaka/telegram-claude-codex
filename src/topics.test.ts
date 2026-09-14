import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTopicOps } from "./state";
import { projectLabel, topicDisplayName } from "./topics";

describe("topic persistence", () => {
  test("upsert, patch, list, remove round-trip and ignore malformed records", () => {
    const dir = mkdtempSync(join(tmpdir(), "topics-"));
    const ops = makeTopicOps(join(dir, "topics.json"));
    expect(ops.list()).toEqual({});
    ops.upsert("t:-1:2", {
      activeProject: "/p/nodarr",
      activeProvider: "claude",
      chatId: -1,
      createdAt: "2026-09-14T00:00:00.000Z",
      efforts: {},
      models: {},
      name: "Nodarr · Claude",
      threadId: 2,
    });
    expect(ops.get("t:-1:2")?.name).toBe("Nodarr · Claude");
    expect(ops.patch("t:-1:2", { activeProvider: "codex" })).toBe(true);
    expect(ops.get("t:-1:2")?.activeProvider).toBe("codex");
    expect(ops.patch("missing", { name: "x" })).toBe(false);
    expect(Object.keys(ops.list())).toEqual(["t:-1:2"]);
    expect(ops.remove("t:-1:2")).toBe(true);
    expect(ops.remove("t:-1:2")).toBe(false);
    expect(ops.list()).toEqual({});
  });

  test("a malformed file yields an empty map instead of crashing", () => {
    const dir = mkdtempSync(join(tmpdir(), "topics-bad-"));
    const path = join(dir, "topics.json");
    mkdirSync(dir, { recursive: true });
    Bun.write(path, '{"topics":{"a":{"chatId":"nope"}},"version":1');
    const ops = makeTopicOps(path);
    expect(ops.list()).toEqual({});
  });
});

describe("topic naming", () => {
  test("known projects get their display label", () => {
    expect(projectLabel("premelone")).toBe("PremelOne");
    expect(projectLabel("it_home")).toBe("Infrastruttura");
    expect(projectLabel("vibravid")).toBe("Vibravid");
  });
  test("display name combines project and provider, custom name wins", () => {
    expect(topicDisplayName("nodarr", "claude").startsWith("Nodarr · ")).toBe(
      true
    );
    expect(
      topicDisplayName("it_home", "claude", "Infra").startsWith("Infra · ")
    ).toBe(true);
  });
});
