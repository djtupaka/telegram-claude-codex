import { afterEach, expect, test } from "bun:test";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupInstallation } from "./setup";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((p) => rm(p, { recursive: true, force: true }))
  );
});
const temporary = async () => {
  const p = await mkdtemp(join(tmpdir(), "setup-bot-"));
  directories.push(p);
  return p;
};
const input = (directory: string) => ({
  directory,
  token: "123456:telegram-test-token",
  userId: "123456",
  projectsDir: join(directory, "projects"),
});

test("dry run describes paths without writing or exposing the token", async () => {
  const directory = await temporary();
  const result = await setupInstallation({ ...input(directory), dryRun: true });
  expect(await readdir(directory)).toEqual([]);
  expect(JSON.stringify(result)).not.toContain("telegram-test-token");
  expect(result.envPath).toBe(join(directory, ".env"));
});

test("creates private configuration with its own projects and optional voice key", async () => {
  const directory = await temporary();
  const result = await setupInstallation(input(directory));
  const content = await readFile(result.envPath, "utf8");
  expect(content).toContain('BOT_TOKEN="123456:telegram-test-token"');
  expect(content).toContain("ALLOWED_USER_ID=123456");
  expect(content).toContain('GROQ_API_KEY=""');
  expect((await stat(result.envPath)).mode % 0o1000).toBe(0o600);
  expect((await stat(input(directory).projectsDir)).isDirectory()).toBe(true);
});

test("never replaces an existing configuration", async () => {
  const directory = await temporary();
  await writeFile(join(directory, ".env"), "original");
  await expect(setupInstallation(input(directory))).rejects.toThrow("esiste");
  expect(await readFile(join(directory, ".env"), "utf8")).toBe("original");
});

test("rejects invalid IDs and newline injection without creating files", async () => {
  const directory = await temporary();
  for (const change of [
    { userId: "123abc" },
    { userId: "0" },
    { token: "123:abc\nEVIL=yes" },
    { projectsDir: "/tmp/a\nOTHER=value" },
  ]) {
    await expect(
      setupInstallation({ ...input(directory), ...change })
    ).rejects.toThrow();
  }
  expect(await readdir(directory)).toEqual([]);
});

test("CLI dry run uses an empty installation without secrets or writes", async () => {
  const directory = await temporary();
  const processResult = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "setup.ts"), "--dry-run"],
    {
      cwd: directory,
      env: { HOME: directory, PATH: process.env.PATH },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  expect(processResult.exitCode).toBe(0);
  expect(new TextDecoder().decode(processResult.stdout)).toContain(
    "nessun file scritto"
  );
  expect(await readdir(directory)).toEqual([]);
});

test("group IDs must be negative safe integers", async () => {
  const directory = await temporary();
  for (const allowedChatIds of [
    "123",
    "-0",
    "-1.5",
    "-9007199254740992",
    "-12,, -13",
  ]) {
    await expect(
      setupInstallation({ ...input(directory), allowedChatIds })
    ).rejects.toThrow("grupp");
  }
  expect(await readdir(directory)).toEqual([]);
  await setupInstallation({
    ...input(directory),
    allowedChatIds: "-100123, -456",
  });
  expect(await readFile(join(directory, ".env"), "utf8")).toContain(
    "ALLOWED_CHAT_IDS=-100123,-456"
  );
});
