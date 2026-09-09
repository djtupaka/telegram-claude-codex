import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectRuntimeVersions,
  readBotVersion,
  runVersionCommand,
} from "./version-info";

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
    expect(readBotVersion(tempPackage('{"version":"1.2.3-beta.1"}'))).toBe(
      "1.2.3-beta.1"
    );
    expect(readBotVersion(tempPackage('{"version":"^1.2.3"}'))).toBe("unknown");
    expect(
      readBotVersion(tempPackage('{"version":"1.2.3\\u009bsecret"}'))
    ).toBe("unknown");
  });
});

describe("collectRuntimeVersions", () => {
  test("reads package versions and sanitizes command output", async () => {
    const packagePath = tempPackage(
      JSON.stringify({
        version: "0.1.0",
        dependencies: {
          "@anthropic-ai/claude-agent-sdk": "0.3.266",
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

  test("omits command output containing likely secrets or unexpected content", async () => {
    const packagePath = tempPackage('{"version":"0.1.0"}');
    const versions = await collectRuntimeVersions(
      async (command) =>
        command === "codex"
          ? "codex-cli 0.153.4 OPENAI_API_KEY=sk-review-secret Bearer review-secret-token"
          : "Claude 2.1.266 password:review-password",
      packagePath
    );

    expect(versions).toEqual({ bot: "0.1.0" });
  });

  test.each([
    "codex-cli 0.153.4 AWS_ACCESS_KEY_ID=AKIAREVIEWSECRET",
    "codex-cli 0.153.4 Authorization: Basic dXNlcjpwYXNz",
    'codex-cli 0.153.4 password="quoted secret" fragment',
    "codex-cli 0.153.4\u009bhidden",
    "codex-cli 0.153.4\u202ehidden",
  ])("fails closed for reviewer payload %p", async (payload) => {
    const packagePath = tempPackage('{"version":"0.1.0"}');
    const versions = await collectRuntimeVersions(
      async (command) => (command === "codex" ? payload : undefined),
      packagePath
    );
    expect(versions.codexCli).toBeUndefined();
    expect(JSON.stringify(versions)).not.toContain("hidden");
    expect(JSON.stringify(versions)).not.toContain("AKIAREVIEWSECRET");
    expect(JSON.stringify(versions)).not.toContain("dXNlcjpwYXNz");
  });

  test("accepts and canonicalizes benign real tool outputs", async () => {
    const packagePath = tempPackage('{"version":"0.1.0"}');
    const versions = await collectRuntimeVersions(
      async (command) =>
        ({
          codex: "codex-cli 0.153.4",
          claude: "2.1.220 (Claude Code)",
          bun: "1.3.14",
          happy: "Happy CLI Version: 1.2.3",
        })[command],
      packagePath
    );

    expect(versions).toEqual({
      bot: "0.1.0",
      codexCli: "codex-cli 0.153.4",
      claudeCli: "2.1.220 (Claude Code)",
      bun: "1.3.14",
      happy: "Happy CLI Version: 1.2.3",
    });
  });

  test("omits non-version package metadata values", async () => {
    const packagePath = tempPackage(
      JSON.stringify({
        version: "0.1.0",
        dependencies: {
          "@openai/codex-sdk": "0.153.4 AWS_ACCESS_KEY_ID=review",
          "@anthropic-ai/claude-agent-sdk": "workspace:*",
          grammy: "1.46.0\u009bhidden",
        },
      })
    );

    expect(
      await collectRuntimeVersions(async () => undefined, packagePath)
    ).toEqual({ bot: "0.1.0" });
  });

  test.each([
    "codex-cli 0.153.4\rsecret",
    "codex-cli 0.153.4\nsecret",
    "codex-cli 0.153.4\r\nsecret",
  ])("treats CR, LF, and CRLF as logical line boundaries", async (output) => {
    const packagePath = tempPackage('{"version":"0.1.0"}');
    const versions = await collectRuntimeVersions(
      async (command) => (command === "codex" ? output : undefined),
      packagePath
    );

    expect(versions.codexCli).toBe("codex-cli 0.153.4");
    expect(JSON.stringify(versions)).not.toContain("secret");
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

  test("kills and reaps a real hung subprocess before returning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dev-bot-version-command-"));
    tempDirs.push(dir);
    const pidPath = join(dir, "pid");
    const commandPath = join(dir, "hung-version");
    writeFileSync(
      commandPath,
      `#!/bin/sh\nprintf '%s' "$$" > '${pidPath}'\ntrap '' TERM\nwhile :; do sleep 1; done\n`
    );
    chmodSync(commandPath, 0o755);
    const started = Date.now();

    expect(await runVersionCommand(commandPath)).toBeUndefined();

    const elapsed = Date.now() - started;
    const pid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
    expect(elapsed).toBeGreaterThanOrEqual(1700);
    expect(elapsed).toBeLessThan(2100);
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
