import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("real createBot routes permissions, callbacks and Codex approval gating in an isolated process", async () => {
  const root = join(import.meta.dir, "..");
  const isolated = mkdtempSync(join(tmpdir(), "dev-bot-integration-"));
  try {
    cpSync(join(root, "src"), join(isolated, "src"), { recursive: true });
    mkdirSync(join(isolated, "scripts"));
    cpSync(
      join(root, "scripts", "bot-integration-harness.ts"),
      join(isolated, "scripts", "bot-integration-harness.ts")
    );
    cpSync(join(root, "package.json"), join(isolated, "package.json"));
    symlinkSync(
      join(root, "node_modules"),
      join(isolated, "node_modules"),
      "dir"
    );
    const child = Bun.spawn(
      [process.execPath, "run", "scripts/bot-integration-harness.ts"],
      {
        cwd: isolated,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: isolated,
          BOT_TOKEN: "123:test",
          ALLOWED_USER_ID: "42",
          GROQ_API_KEY: "test",
          PROJECTS_DIR: isolated,
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const timer = setTimeout(() => child.kill(), 20_000);
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(timer);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(stdout).toContain("BOT_INTEGRATION_OK");
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
}, 30_000);
