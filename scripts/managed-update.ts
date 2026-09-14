import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  formatUpdateStatus,
  readUpdateStatus,
  type UpdateReceipt,
  updateDirectory,
} from "../src/update-status";
import { UNIT } from "./service-unit";

interface Result {
  code: number;
  stdout: string;
}
interface Dependencies {
  command(
    args: string[],
    cwd?: string,
    env?: Record<string, string>
  ): Promise<Result>;
}
type Operation = "apply" | "rollback";
const POSITIVE_PID = /^[1-9]\d*$/;
const HASH = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const CHECKS = [
  ["bun", "install", "--frozen-lockfile"],
  ["bun", "test"],
  ["bun", "run", "typecheck"],
  ["bun", "run", "lint"],
];

function command(
  args: string[],
  cwd: string,
  env?: Record<string, string>
): Promise<Result> {
  const result = Bun.spawnSync(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: env ?? { ...process.env, HUSKY: "0" },
    timeout: 300_000,
  });
  // Child output can contain configuration: never print it in errors/receipts.
  return Promise.resolve({
    code: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
  });
}
async function checked(
  deps: Dependencies,
  args: string[],
  cwd: string,
  env?: Record<string, string>
): Promise<string> {
  const result = await deps.command(args, cwd, env);
  if (result.code !== 0) {
    throw new Error(
      `Comando non riuscito: ${args.slice(0, 3).join(" ")}. Eseguire il controllo manualmente per i dettagli.`
    );
  }
  return result.stdout.trim();
}
async function assertStopped(
  deps: Dependencies,
  directory: string
): Promise<void> {
  const pid = await checked(
    deps,
    ["systemctl", "--user", "show", UNIT, "--property=MainPID", "--value"],
    directory
  );
  if (pid !== "0") {
    throw new Error(
      "Il servizio deve essere arrestato: terminare tutte le sessioni e usare bun run service:stop da un terminale esterno al bot."
    );
  }
  const workingDirectory = await checked(
    deps,
    [
      "systemctl",
      "--user",
      "show",
      UNIT,
      "--property=WorkingDirectory",
      "--value",
    ],
    directory
  );
  const execStart = await checked(
    deps,
    ["systemctl", "--user", "show", UNIT, "--property=ExecStart", "--value"],
    directory
  );
  if (
    !execStart.includes(
      `argv[]=${process.execPath} run ${resolve(directory, "src/index.ts")} ;`
    )
  ) {
    throw new Error(
      "ExecStart del servizio non corrisponde al checkout e al runtime attesi. Reinstallare il servizio con service:install."
    );
  }
  const state = await checked(
    deps,
    ["systemctl", "--user", "show", UNIT, "--property=ActiveState", "--value"],
    directory
  );
  if (
    resolve(workingDirectory) !== resolve(directory) ||
    !["inactive", "failed"].includes(state)
  ) {
    throw new Error(
      "Il servizio deve puntare a questo checkout ed essere completamente arrestato."
    );
  }
}
async function assertClean(
  deps: Dependencies,
  directory: string
): Promise<string> {
  if (
    await checked(
      deps,
      ["git", "status", "--porcelain=v1", "--untracked-files=no"],
      directory
    )
  ) {
    throw new Error(
      "File tracciati modificati: salvare le modifiche prima di aggiornare."
    );
  }
  if (
    (await checked(deps, ["git", "branch", "--show-current"], directory)) !==
    "main"
  ) {
    throw new Error("Aggiornamento consentito soltanto sul branch main.");
  }
  if (
    (await checked(
      deps,
      ["git", "rev-parse", "--abbrev-ref", "main@{upstream}"],
      directory
    )) !== "origin/main"
  ) {
    throw new Error("Il branch main deve seguire origin/main.");
  }
  return checked(deps, ["git", "rev-parse", "HEAD"], directory);
}

interface BackupFile {
  data: string;
  path: string;
  sha256: string;
}
async function snapshot(
  directory: string,
  relative: string,
  files: BackupFile[]
): Promise<void> {
  let info: Stats;
  try {
    info = await lstat(join(directory, relative));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (info.isDirectory()) {
    if (relative !== ".data") {
      throw new Error("Percorso di stato non valido.");
    }
    for (const name of (await readdir(join(directory, relative))).sort()) {
      if (name.endsWith(".json")) {
        await snapshot(directory, join(relative, name), files);
      }
    }
  } else if (info.isFile()) {
    const usedBytes = files.reduce(
      (sum, file) => sum + Buffer.byteLength(file.data, "base64"),
      0
    );
    if (info.size + usedBytes > 32 * 1024 * 1024) {
      throw new Error(
        "Stato/configurazione oltre 32 MiB: usare un backup dedicato prima di aggiornare."
      );
    }
    const data = await readFile(join(directory, relative));
    if (data.length + usedBytes > 32 * 1024 * 1024) {
      throw new Error("Stato cambiato durante il backup o oltre 32 MiB.");
    }
    files.push({
      path: relative,
      data: data.toString("base64"),
      sha256: createHash("sha256").update(data).digest("hex"),
    });
  } else {
    throw new Error(
      "Backup interrotto: stato o configurazione contengono link o file speciali."
    );
  }
}
export async function createVerifiedBackup(
  directory: string,
  path: string
): Promise<{ path: string; files: number }> {
  const files: BackupFile[] = [];
  await snapshot(directory, ".env", files);
  await snapshot(directory, ".data", files);
  await writeFile(path, JSON.stringify({ version: 1, files }), {
    mode: 0o600,
    flag: "wx",
  });
  const restore = await mkdtemp(join(tmpdir(), "dev-bot-restore-"));
  try {
    const saved = JSON.parse(await readFile(path, "utf8")) as {
      files: BackupFile[];
    };
    if (saved.files.length !== files.length) {
      throw new Error("Backup incompleto.");
    }
    for (const [index, file] of saved.files.entries()) {
      const target = join(restore, file.path);
      if (!target.startsWith(`${restore}/`)) {
        throw new Error("Percorso backup non valido.");
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, Buffer.from(file.data, "base64"), {
        mode: 0o600,
        flag: "wx",
      });
      const digest = createHash("sha256")
        .update(await readFile(target))
        .digest("hex");
      if (digest !== files[index]?.sha256 || file.path !== files[index]?.path) {
        throw new Error("Verifica ripristino backup non riuscita.");
      }
    }
  } finally {
    await rm(restore, { recursive: true, force: true });
  }
  return { path, files: files.length };
}
async function saveReceipt(
  store: string,
  receipt: UpdateReceipt
): Promise<void> {
  const temporary = join(store, `${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, join(store, "latest.json"));
  await writeFile(
    join(store, `${receipt.timestamp.replaceAll(":", "-")}.json`),
    JSON.stringify(receipt, null, 2),
    { mode: 0o600 }
  );
}
async function startAndConfirm(
  deps: Dependencies,
  directory: string,
  target: string
): Promise<number> {
  const since = `@${Math.floor(Date.now() / 1000)}`;
  await checked(deps, ["systemctl", "--user", "start", UNIT], directory);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const pid = await checked(
      deps,
      ["systemctl", "--user", "show", UNIT, "--property=MainPID", "--value"],
      directory
    );
    if (POSITIVE_PID.test(pid)) {
      const marker = `Bot started revision ${target.slice(0, 12)}`;
      const journal = await deps.command(
        [
          "journalctl",
          "--user",
          "-u",
          UNIT,
          "--since",
          since,
          "--no-pager",
          "--output=cat",
          "--grep",
          `^${marker}$`,
          `_PID=${pid}`,
        ],
        directory
      );
      if (
        journal.code === 0 &&
        journal.stdout.split("\n").some((line) => line.trim() === marker)
      ) {
        return Number(pid);
      }
    }
    await Bun.sleep(1000);
  }
  throw new Error(
    "Codice installato, ma avvio della versione non confermato entro 30 secondi. Controllare service:status e service:logs prima di riprovare."
  );
}

async function targetCommit(
  operation: Operation,
  directory: string,
  from: string,
  deps: Dependencies
): Promise<string> {
  let to: string;
  if (operation === "apply") {
    await checked(deps, ["git", "fetch", "origin", "main"], directory);
    to = await checked(
      deps,
      ["git", "rev-parse", "refs/remotes/origin/main"],
      directory
    );
    await checked(
      deps,
      ["git", "merge-base", "--is-ancestor", from, to],
      directory
    );
  } else {
    const store = updateDirectory(directory);
    const history: UpdateReceipt[] = [];
    for (const name of await readdir(store)) {
      if (name.endsWith(".json") && !name.startsWith("backup-")) {
        const value = JSON.parse(
          await readFile(join(store, name), "utf8")
        ) as UpdateReceipt;
        if (value.to === from && HASH.test(value.from) && value.from !== from) {
          history.push(value);
        }
      }
    }
    history.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const previous = history[0];
    if (
      !previous ||
      previous.to !== from ||
      previous.from === from ||
      !HASH.test(previous.from)
    ) {
      throw new Error(
        "Nessuna ricevuta compatibile per il rollback della versione corrente."
      );
    }
    to = previous.from;
  }
  if (!HASH.test(to)) {
    throw new Error("Commit destinazione non valido.");
  }
  if (from === to) {
    throw new Error("La versione richiesta è già installata.");
  }
  if (
    await checked(
      deps,
      ["git", "ls-tree", "-r", "--name-only", to, "--", ".env", ".data"],
      directory
    )
  ) {
    throw new Error(
      "La destinazione traccia stato o configurazione privata: aggiornamento rifiutato."
    );
  }
  return to;
}

export async function runManagedUpdate(
  operation: Operation,
  directory: string,
  deps: Dependencies = {
    command: (args, cwd, env) => command(args, cwd ?? directory, env),
  }
): Promise<UpdateReceipt> {
  await assertStopped(deps, directory);
  const store = updateDirectory(directory);
  await mkdir(store, { recursive: true, mode: 0o700 });
  await chmod(store, 0o700);
  const lock = join(store, "lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    throw new Error(
      "Un aggiornamento è già in corso (lock presente). Consultare docs/AGGIORNAMENTI.md."
    );
  }
  let staging: string | undefined;
  let checkHome: string | undefined;
  let receipt: UpdateReceipt | undefined;
  try {
    const from = await assertClean(deps, directory);
    const to = await targetCommit(operation, directory, from, deps);
    staging = await mkdtemp(join(tmpdir(), "dev-bot-candidate-"));
    await checked(
      deps,
      ["git", "worktree", "add", "--detach", staging, to],
      directory
    );
    checkHome = await mkdtemp(join(tmpdir(), "dev-bot-check-home-"));
    const checkEnv = {
      HOME: checkHome,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LANG: "C.UTF-8",
      HUSKY: "0",
      CI: "1",
    };
    for (const args of CHECKS) {
      await checked(deps, args, staging, checkEnv);
    }
    await assertStopped(deps, directory);
    if ((await assertClean(deps, directory)) !== from) {
      throw new Error(
        "Commit cambiato durante la verifica: operazione annullata."
      );
    }
    const backup = join(store, `backup-${randomUUID()}.json`);
    await createVerifiedBackup(directory, backup);
    receipt = {
      operation,
      from,
      to,
      backup,
      checks: CHECKS.map((args) => args.join(" ")),
      mainPid: 0,
      status: "prepared",
      timestamp: new Date().toISOString(),
    };
    await saveReceipt(store, receipt);
    await assertStopped(deps, directory);
    if ((await assertClean(deps, directory)) !== from) {
      throw new Error("Checkout cambiato dopo il backup.");
    }
    // --keep refuses overlapping local changes; rollback moves main to the receipt's prior commit.
    await checked(
      deps,
      operation === "apply"
        ? ["git", "merge", "--ff-only", to]
        : ["git", "reset", "--keep", to],
      directory
    );
    await checked(
      deps,
      ["bun", "install", "--frozen-lockfile"],
      directory,
      checkEnv
    );
    receipt.status = "installed";
    await saveReceipt(store, receipt);
    receipt.mainPid = await startAndConfirm(deps, directory, to);
    receipt.status = "success";
    await saveReceipt(store, receipt);
    return receipt;
  } catch (error) {
    if (receipt) {
      receipt.status = "failed";
      receipt.reason =
        error instanceof Error ? error.message : "Aggiornamento non riuscito.";
      await saveReceipt(store, receipt);
    }
    throw error;
  } finally {
    if (staging) {
      const removed = await deps.command(
        ["git", "worktree", "remove", "--force", staging],
        directory
      );
      if (removed.code !== 0) {
        console.error(`Pulizia checkout temporaneo non riuscita: ${staging}`);
      }
    }
    if (checkHome) {
      await rm(checkHome, { recursive: true, force: true });
    }
    await rm(lock, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const directory = resolve(import.meta.dir, "..");
  try {
    const [operation, ...extra] = process.argv.slice(2);
    if (extra.length) {
      throw new Error("Il comando non accetta argomenti aggiuntivi.");
    }
    if (operation === "status") {
      console.log(formatUpdateStatus(await readUpdateStatus(directory)));
    } else if (operation === "check") {
      const deps = {
        command: (args: string[], cwd?: string) =>
          command(args, cwd ?? directory),
      };
      const from = await assertClean(deps, directory);
      await checked(deps, ["git", "fetch", "origin", "main"], directory);
      const to = await checked(
        deps,
        ["git", "rev-parse", "refs/remotes/origin/main"],
        directory
      );
      await checked(
        deps,
        ["git", "merge-base", "--is-ancestor", from, to],
        directory
      );
      console.log(
        from === to
          ? "Versione già aggiornata."
          : `Aggiornamento disponibile: ${from.slice(0, 12)} → ${to.slice(0, 12)}. Nessuna modifica al codice applicata.`
      );
    } else if (operation === "apply" || operation === "rollback") {
      console.log(JSON.stringify(await runManagedUpdate(operation, directory)));
    } else {
      throw new Error(
        "Uso: bun run scripts/managed-update.ts status|check|apply|rollback"
      );
    }
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Aggiornamento non riuscito."
    );
    process.exitCode = 1;
  }
}
