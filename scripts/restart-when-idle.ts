import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { UNIT } from "./service-unit";

export interface RestartOptions {
  backup: string;
  expectedCommit: string;
  expectedPid: number;
}
export interface CommandResult {
  code: number;
  stdout: string;
}
export interface RestartReceipt {
  backup: string;
  commit: string;
  mainPid: number;
  reason?: string;
  status: "success" | "failed";
  timestamp: string;
}
export interface RestartDependencies {
  backupExists(path: string): Promise<boolean>;
  children(pid: number): Promise<number[]>;
  command(args: string[]): Promise<CommandResult>;
  now(): number;
  sleep(ms: number): Promise<void>;
  writeReceipt(receipt: RestartReceipt): Promise<void>;
}

const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const POSITIVE_INTEGER = /^[1-9]\d*$/;
const WHITESPACE = /\s+/;
const POLL_MS = 5000;
const DEADLINE_MS = 30 * 60_000;
const STARTUP_MS = 30_000;
const STARTUP_POLL_MS = 1000;
const SHORT_LENGTH = 12;
const MILLISECONDS_PER_SECOND = 1000;

function validate(options: RestartOptions): void {
  if (
    !Number.isSafeInteger(options.expectedPid) ||
    options.expectedPid <= 0 ||
    !COMMIT.test(options.expectedCommit) ||
    !isAbsolute(options.backup)
  ) {
    throw new Error(
      "Servono PID positivo, commit completo e percorso assoluto del backup."
    );
  }
}
async function mainPid(deps: RestartDependencies): Promise<number> {
  const result = await deps.command([
    "systemctl",
    "--user",
    "show",
    UNIT,
    "--property=MainPID",
    "--value",
  ]);
  const value = result.stdout.trim();
  if (
    result.code !== 0 ||
    !POSITIVE_INTEGER.test(value) ||
    !Number.isSafeInteger(Number(value))
  ) {
    throw new Error("PID del servizio non disponibile.");
  }
  return Number(value);
}
async function unchanged(
  options: RestartOptions,
  deps: RestartDependencies
): Promise<void> {
  if ((await mainPid(deps)) !== options.expectedPid) {
    throw new Error("PID del servizio cambiato: nessun riavvio.");
  }
  const head = await deps.command(["git", "rev-parse", "HEAD"]);
  if (head.code !== 0 || head.stdout.trim() !== options.expectedCommit) {
    throw new Error("Commit cambiato: nessun riavvio.");
  }
  const tree = await deps.command([
    "git",
    "status",
    "--porcelain=v1",
    "--untracked-files=no",
  ]);
  if (tree.code !== 0 || tree.stdout.trim()) {
    throw new Error("File tracciati o indice modificati: nessun riavvio.");
  }
  if (!(await deps.backupExists(options.backup))) {
    throw new Error("Backup non disponibile: nessun riavvio.");
  }
}
async function waitForIdle(
  options: RestartOptions,
  deps: RestartDependencies
): Promise<void> {
  const deadline = deps.now() + DEADLINE_MS;
  let idleAt: number | undefined;
  while (deps.now() < deadline) {
    await unchanged(options, deps);
    const children = await deps.children(options.expectedPid);
    if (children.length) {
      idleAt = undefined;
    } else if (idleAt !== undefined && deps.now() - idleAt >= POLL_MS) {
      // This is a final best-effort check, not an atomic lock: a new child or
      // commit can still appear between this check and systemctl restart.
      await unchanged(options, deps);
      if (
        !(await deps.children(options.expectedPid)).length &&
        deps.now() < deadline
      ) {
        return;
      }
      idleAt = undefined;
    } else {
      idleAt = deps.now();
    }
    await deps.sleep(POLL_MS);
  }
  throw new Error("Scadenza di 30 minuti raggiunta: nessun riavvio.");
}
async function confirmStartup(
  options: RestartOptions,
  deps: RestartDependencies,
  since: string
): Promise<number> {
  const deadline = deps.now() + STARTUP_MS;
  const marker = `Bot started revision ${options.expectedCommit.slice(0, SHORT_LENGTH)}`;
  while (deps.now() < deadline) {
    const active = await deps.command([
      "systemctl",
      "--user",
      "is-active",
      UNIT,
    ]);
    if (active.code === 0 && active.stdout.trim() === "active") {
      const pid = await mainPid(deps);
      if (pid !== options.expectedPid) {
        const journal = await deps.command([
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
        ]);
        if (
          journal.code === 0 &&
          journal.stdout.split("\n").some((line) => line.trim() === marker)
        ) {
          return pid;
        }
      }
    }
    await deps.sleep(STARTUP_POLL_MS);
  }
  throw new Error("Verifica avvio non riuscita entro 30 secondi.");
}

export async function restartWhenIdle(
  options: RestartOptions,
  deps: RestartDependencies
): Promise<RestartReceipt> {
  validate(options);
  let pid = options.expectedPid;
  let status: RestartReceipt["status"] = "failed";
  let reason: string | undefined;
  try {
    await waitForIdle(options, deps);
    const since = `@${Math.floor(deps.now() / MILLISECONDS_PER_SECOND)}`;
    const restart = await deps.command([
      "systemctl",
      "--user",
      "restart",
      UNIT,
    ]);
    if (restart.code !== 0) {
      throw new Error("Comando di riavvio non riuscito.");
    }
    pid = await mainPid(deps);
    pid = await confirmStartup(options, deps, since);
    status = "success";
  } catch (error) {
    reason =
      error instanceof Error
        ? error.message
        : "Riavvio differito non riuscito.";
  }
  const receipt: RestartReceipt = {
    status,
    timestamp: new Date(deps.now()).toISOString(),
    mainPid: pid,
    commit: options.expectedCommit,
    backup: options.backup,
    ...(reason ? { reason } : {}),
  };
  await deps.writeReceipt(receipt);
  return receipt;
}

export interface ProcessFiles {
  children(path: string): Promise<string>;
  tasks(path: string): Promise<string[]>;
}
export async function readProcessChildren(
  pid: number,
  files: ProcessFiles
): Promise<number[]> {
  const base = `/proc/${pid}/task`;
  const threads = await files.tasks(base);
  if (
    !threads.length ||
    threads.some((thread) => !POSITIVE_INTEGER.test(thread))
  ) {
    throw new Error("Elenco thread non valido.");
  }
  const found = new Set<number>();
  for (const thread of threads) {
    const text = (await files.children(`${base}/${thread}/children`)).trim();
    if (!text) {
      continue;
    }
    const values = text.split(WHITESPACE);
    if (
      values.some(
        (value) =>
          !(POSITIVE_INTEGER.test(value) && Number.isSafeInteger(Number(value)))
      )
    ) {
      throw new Error("Elenco processi figli non valido.");
    }
    for (const value of values) {
      found.add(Number(value));
    }
  }
  return [...found];
}

export async function backupExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const flags = new Map<string, string>();
    const allowed = new Set([
      "--expected-pid",
      "--expected-commit",
      "--backup",
    ]);
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index];
      const value = args[index + 1];
      if (!(flag && allowed.has(flag) && value) || flags.has(flag)) {
        throw new Error("Argomenti del riavvio differito non validi.");
      }
      flags.set(flag, value);
    }
    const options = {
      expectedPid: Number(flags.get("--expected-pid")),
      expectedCommit: flags.get("--expected-commit") ?? "",
      backup: flags.get("--backup") ?? "",
    };
    const directory = resolve(import.meta.dir, "..");
    const receipt = await restartWhenIdle(options, {
      now: Date.now,
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      command: (args) => {
        const result = Bun.spawnSync(args, {
          cwd: directory,
          stdout: "pipe",
          stderr: "pipe",
          timeout: STARTUP_MS,
        });
        return Promise.resolve({
          code: result.exitCode,
          stdout: new TextDecoder().decode(result.stdout),
        });
      },
      children: (pid) =>
        readProcessChildren(pid, {
          tasks: (path) => readdir(path),
          children: (path) => readFile(path, "utf8"),
        }),
      backupExists,
      writeReceipt: async (value) => {
        const releases = join(directory, ".data", "releases");
        await mkdir(releases, { recursive: true, mode: 0o700 });
        const path = join(releases, `${value.commit}.json`);
        const temporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
          flag: "wx",
          mode: 0o600,
        });
        await rename(temporary, path);
      },
    });
    console.log(JSON.stringify(receipt));
    process.exitCode = receipt.status === "success" ? 0 : 1;
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Riavvio differito non riuscito."
    );
    process.exitCode = 1;
  }
}
