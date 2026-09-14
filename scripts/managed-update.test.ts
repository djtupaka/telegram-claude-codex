import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVerifiedBackup, runManagedUpdate } from "./managed-update";

test("il backup ripristina in isolamento stato e configurazione con permessi protetti", async () => {
  const root = await mkdtemp(join(tmpdir(), "update-backup-"));
  try {
    await mkdir(join(root, ".data"));
    await writeFile(join(root, ".env"), "BOT_TOKEN=segreto\n");
    await writeFile(
      join(root, ".data", "state.json"),
      '{"session":"corrente"}'
    );
    await mkdir(join(root, ".data", "backups"));
    await writeFile(join(root, ".data", "backups", "old.json"), "non copiare");
    await writeFile(join(root, ".data", "events.jsonl"), "non copiare");
    const backup = await createVerifiedBackup(root, join(root, "backup.json"));
    expect(backup.files).toBe(2);
    expect((await stat(backup.path)).mode % 0o1000).toBe(0o600);
    expect(await readFile(join(root, ".env"), "utf8")).toBe(
      "BOT_TOKEN=segreto\n"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("apply rifiuta servizio attivo prima di fetch, backup o modifica checkout", async () => {
  const calls: string[][] = [];
  await expect(
    runManagedUpdate("apply", "/tmp/example", {
      command: (args) => {
        calls.push(args);
        return Promise.resolve({ code: 0, stdout: "123\n" });
      },
    })
  ).rejects.toThrow("servizio");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.[0]).toBe("systemctl");
});

test("apply e rollback verificano commit reali e preservano lo stato più recente", async () => {
  const root = await mkdtemp(join(tmpdir(), "update-git-"));
  const remote = join(root, "remote");
  const checkout = join(root, "checkout");
  const git = (args: string[], cwd: string) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new Error(new TextDecoder().decode(result.stderr));
    }
    return new TextDecoder().decode(result.stdout).trim();
  };
  let running = false;
  let failMerge = false;
  const calls: string[][] = [];
  try {
    await mkdir(remote);
    git(["init", "-b", "main"], remote);
    git(["config", "user.email", "test@example.invalid"], remote);
    git(["config", "user.name", "Test"], remote);
    await writeFile(join(remote, ".gitignore"), ".data/\n.env\n");
    await writeFile(join(remote, "version.txt"), "prima");
    git(["add", "."], remote);
    git(["commit", "-m", "prima"], remote);
    git(["clone", remote, checkout], root);
    await writeFile(join(remote, "version.txt"), "seconda");
    git(["commit", "-am", "seconda"], remote);
    await mkdir(join(checkout, ".data"));
    await writeFile(join(checkout, ".data", "state.json"), "prima");
    const deps = {
      command: (
        args: string[],
        cwd = checkout,
        env?: Record<string, string>
      ) => {
        calls.push(args);
        if (args[0] === "git") {
          if (failMerge && args[1] === "merge") {
            return Promise.resolve({ code: 1, stdout: "" });
          }
          const result = Bun.spawnSync(args, {
            cwd,
            stdout: "pipe",
            stderr: "pipe",
          });
          return Promise.resolve({
            code: result.exitCode,
            stdout: new TextDecoder().decode(result.stdout),
          });
        }
        if (args[0] === "systemctl") {
          if (args.includes("--property=ExecStart")) {
            return Promise.resolve({
              code: 0,
              stdout: `{ path=${process.execPath} ; argv[]=${process.execPath} run ${checkout}/src/index.ts ; ignore_errors=no ; }`,
            });
          }
          if (args.includes("--property=WorkingDirectory")) {
            return Promise.resolve({ code: 0, stdout: checkout });
          }
          if (args.includes("--property=ActiveState")) {
            return Promise.resolve({
              code: 0,
              stdout: running ? "active" : "inactive",
            });
          }
          if (args.includes("start")) {
            running = true;
          }
          return Promise.resolve({
            code: 0,
            stdout: running ? "321\n" : "0\n",
          });
        }
        if (args[0] === "journalctl") {
          return Promise.resolve({
            code: 0,
            stdout: `Bot started revision ${git(["rev-parse", "HEAD"], checkout).slice(0, 12)}\n`,
          });
        }
        expect(env?.HOME).toContain("dev-bot-check-home-");
        expect(env?.BOT_TOKEN).toBeUndefined();
        return Promise.resolve({ code: 0, stdout: "" });
      },
    };
    await writeFile(join(checkout, "version.txt"), "modifica locale");
    await expect(runManagedUpdate("apply", checkout, deps)).rejects.toThrow(
      "modificati"
    );
    expect(await readFile(join(checkout, "version.txt"), "utf8")).toBe(
      "modifica locale"
    );
    await writeFile(join(checkout, "version.txt"), "prima");
    await writeFile(join(remote, ".env"), "segreto");
    git(["add", "-f", ".env"], remote);
    git(["commit", "-m", "configurazione erroneamente tracciata"], remote);
    await expect(runManagedUpdate("apply", checkout, deps)).rejects.toThrow(
      "configurazione"
    );
    git(["rm", ".env"], remote);
    git(["commit", "-m", "rimuovi configurazione tracciata"], remote);
    const applied = await runManagedUpdate("apply", checkout, deps);
    expect(applied.status).toBe("success");
    expect(await readFile(join(checkout, "version.txt"), "utf8")).toBe(
      "seconda"
    );
    await writeFile(join(checkout, ".data", "state.json"), "sessione-nuova");
    running = false;
    await writeFile(join(remote, "version.txt"), "terza");
    git(["commit", "-am", "terza"], remote);
    failMerge = true;
    await expect(runManagedUpdate("apply", checkout, deps)).rejects.toThrow(
      "git merge"
    );
    expect(git(["rev-parse", "HEAD"], checkout)).toBe(applied.to);
    failMerge = false;
    const rollback = await runManagedUpdate("rollback", checkout, deps);
    expect(rollback.to).toBe(applied.from);
    expect(await readFile(join(checkout, "version.txt"), "utf8")).toBe("prima");
    expect(await readFile(join(checkout, ".data", "state.json"), "utf8")).toBe(
      "sessione-nuova"
    );
    expect(calls.some((args) => args.includes("--hard"))).toBe(false);
    expect(
      calls.filter((args) => args[0] === "bun" && args[1] === "test")
    ).toHaveLength(3);
  } finally {
    const { updateDirectory } = await import("../src/update-status");
    await rm(updateDirectory(checkout), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
