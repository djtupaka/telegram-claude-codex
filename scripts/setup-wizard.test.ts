import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetupWizard } from "./setup-wizard";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((p) => rm(p, { recursive: true, force: true }))
  );
});
async function temporary() {
  const p = await mkdtemp(join(tmpdir(), "wizard-bot-"));
  directories.push(p);
  return p;
}

test("wizard collects private credentials, optional groups and writes only after confirmation", async () => {
  const directory = await temporary();
  const answers = [
    "123:private-token",
    "123",
    join(directory, "projects"),
    "private-groq",
    "-100123",
    "s",
  ];
  const prompts: { secret?: boolean }[] = [];
  await runSetupWizard({
    directory,
    defaultProjectsDir: join(directory, "default"),
    prompt: async (question) => {
      expect(await readdir(directory)).toEqual([]);
      prompts.push(question);
      return answers.shift() ?? "";
    },
  });
  expect(prompts[0]?.secret).toBe(true);
  expect(prompts[3]?.secret).toBe(true);
  expect(await readFile(join(directory, ".env"), "utf8")).toContain(
    "ALLOWED_CHAT_IDS=-100123"
  );
});

test("cancellation at a prompt or final confirmation leaves no files", async () => {
  for (const answers of [[null], ["123:token", "123", "", "", "", "n"]]) {
    const directory = await temporary();
    const result = await runSetupWizard({
      directory,
      defaultProjectsDir: join(directory, "projects"),
      prompt: async () => answers.shift() ?? null,
    });
    expect(result).toBeNull();
    expect(await readdir(directory)).toEqual([]);
  }
});

test("wizard refuses even dangling .env symlinks before asking for credentials", async () => {
  const directory = await temporary();
  await symlink(join(directory, "missing"), join(directory, ".env"));
  let prompted = false;
  await expect(
    runSetupWizard({
      directory,
      defaultProjectsDir: directory,
      prompt: async () => {
        prompted = true;
        return "";
      },
    })
  ).rejects.toThrow("esiste");
  expect(prompted).toBe(false);
});

test("wizard dry run validates answers without writing", async () => {
  const directory = await temporary();
  const answers = ["123:token", "123", "", "", ""];
  const result = await runSetupWizard({
    directory,
    defaultProjectsDir: join(directory, "projects"),
    dryRun: true,
    prompt: async () => answers.shift() ?? null,
  });
  expect(result?.dryRun).toBe(true);
  expect(await readdir(directory)).toEqual([]);
});
