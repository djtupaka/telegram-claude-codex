import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectRuntimeVersions, readBotVersion } from "./version-info";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

const tempPackage = (contents: string) => {
  const dir = mkdtempSync(join(tmpdir(), "dev-bot-version-"));
  tempDirs.push(dir);
  const path = join(dir, "package.json");
  writeFileSync(path, contents);
  return path;
};

describe("readBotVersion", () => {
  test("reads the package metadata version", () => {
    const path = tempPackage('{"version":"1.2.3"}');
    expect(readBotVersion(path)).toBe("1.2.3");
  });

  test("package metadata failure returns unknown", () => {
    expect(readBotVersion("/missing/package.json")).toBe("unknown");
    expect(readBotVersion(tempPackage("not json"))).toBe("unknown");
  });
});

describe("collectRuntimeVersions", () => {
  test("reads package versions and sanitizes command output", async () => {
    const packagePath = tempPackage(
      JSON.stringify({
        version: " 0.1.0\nnot-a-version ",
        dependencies: {
          "@anthropic-ai/claude-agent-sdk": "0.3.266\nsecret",
          "@openai/codex-sdk": "0.153.4",
          grammy: "1.46.0",
        },
      })
    );
    const versions = await collectRuntimeVersions(
      async (cmd) =>
        cmd === "codex"
          ? `  codex-cli 0.153.4\nignored ${"x".repeat(200)}`
          : undefined,
      packagePath
    );

    expect(versions).toEqual({
      bot: "0.1.0",
      claudeAgentSdk: "0.3.266",
      codexSdk: "0.153.4",
      grammy: "1.46.0",
      codexCli: "codex-cli 0.153.4",
    });
    expect(JSON.stringify(versions)).not.toContain("undefined");
  });

  test("omits command failures", async () => {
    const packagePath = tempPackage('{"version":"0.1.0"}');
    const versions = await collectRuntimeVersions(async () => {
      throw new Error("secret stderr");
    }, packagePath);

    expect(versions).toEqual({ bot: "0.1.0" });
    expect(JSON.stringify(versions)).not.toContain("secret stderr");
  });

  test("bounds a non-returning command to two seconds", async () => {
    const packagePath = tempPackage('{"version":"0.1.0"}');
    const started = Date.now();
    const versions = await collectRuntimeVersions(
      () => new Promise<string | undefined>(() => undefined),
      packagePath
    );

    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
    expect(Date.now() - started).toBeLessThan(2600);
    expect(versions).toEqual({ bot: "0.1.0" });
  });
});
