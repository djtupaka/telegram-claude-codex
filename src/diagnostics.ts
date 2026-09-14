import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat, statfs } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface DiagnosticCheck {
  detail: string;
  id: string;
  label: string;
  status: "ok" | "warning" | "error" | "info";
}
export interface DiagnosticReport {
  checks: DiagnosticCheck[];
  hasBlockers: boolean;
}
interface DiagnosticOptions {
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  projectsDir: string;
}
interface DiagnosticDependencies {
  probeCommand?: (command: string, env: NodeJS.ProcessEnv) => Promise<boolean>;
}

const TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{30,}$/;
const USER_PATTERN = /^[1-9]\d*$/;
const CHAT_PATTERN = /^-[1-9]\d*$/;
const LOW_DISK_BYTES = 1024 ** 3;

function probeCommand(
  command: string,
  env: NodeJS.ProcessEnv
): Promise<boolean> {
  return new Promise((resolveProbe) => {
    // Version output and stderr are deliberately discarded, including on failure.
    execFile(
      command,
      ["--version"],
      {
        env,
        shell: false,
        timeout: 3000,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024,
      },
      (error) => resolveProbe(error === null)
    );
  });
}

async function nearestExisting(path: string): Promise<string> {
  let current = resolve(path);
  for (;;) {
    try {
      await stat(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(current);
      if (parent === current) {
        throw error;
      }
      current = parent;
    }
  }
}

async function directoryCheck(
  id: string,
  label: string,
  path: string,
  mustExist: boolean
): Promise<DiagnosticCheck> {
  try {
    const existing = await nearestExisting(path);
    const present = existing === resolve(path);
    if (!(await stat(existing)).isDirectory() || (mustExist && !present)) {
      return {
        id,
        label,
        status: "error",
        detail: "Directory assente o percorso non valido.",
      };
    }
    // biome-ignore lint/suspicious/noBitwiseOperators: fs.access expects a permission mask.
    await access(existing, constants.R_OK | constants.W_OK | constants.X_OK);
    return {
      id,
      label,
      status: "ok",
      detail: present
        ? "Directory accessibile in lettura e scrittura."
        : "Directory ancora assente; cartella padre accessibile in lettura e scrittura. Nessun file creato.",
    };
  } catch {
    return {
      id,
      label,
      status: "error",
      detail: "Percorso non accessibile in lettura e scrittura.",
    };
  }
}

async function diskCheck(
  id: string,
  label: string,
  path: string
): Promise<DiagnosticCheck> {
  try {
    const disk = await statfs(await nearestExisting(path));
    const available = disk.bavail * disk.bsize;
    return {
      id,
      label,
      status: available < LOW_DISK_BYTES ? "warning" : "ok",
      detail: `${(available / LOW_DISK_BYTES).toFixed(1)} GiB disponibili sul filesystem del percorso o della cartella padre esistente.`,
    };
  } catch {
    return {
      id,
      label,
      status: "warning",
      detail: "Spazio disponibile non verificabile.",
    };
  }
}

/** Local read-only checks: no bot startup, network requests, provider runs or login. */
export async function collectDiagnostics(
  options: DiagnosticOptions,
  dependencies: DiagnosticDependencies = {}
): Promise<DiagnosticReport> {
  const env = options.env ?? process.env;
  const dataDir = options.dataDir ?? join(import.meta.dirname, "..", ".data");
  const attachmentsDir =
    env.ATTACHMENTS_DIR?.trim() ||
    env.UPLOADS_DIR?.trim() ||
    join(dataDir, "attachments");
  const tokenValid = TOKEN_PATTERN.test(env.BOT_TOKEN ?? "");
  const user = env.ALLOWED_USER_ID ?? "";
  const userValid =
    USER_PATTERN.test(user) && Number.isSafeInteger(Number(user));
  const chats = (env.ALLOWED_CHAT_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const chatsValid = chats.every(
    (value) => CHAT_PATTERN.test(value) && Number.isSafeInteger(Number(value))
  );
  const groqDisabledStatus = env.GROQ_API_KEY === undefined ? "error" : "info";
  const groqDisabledDetail =
    env.GROQ_API_KEY === undefined
      ? 'Variabile richiesta dalla configurazione: impostare GROQ_API_KEY="" per disabilitare la trascrizione facoltativa.'
      : "Funzione facoltativa disabilitata: chiave vuota.";
  const checks: DiagnosticCheck[] = [
    {
      id: "telegram-token",
      label: "Telegram · BOT_TOKEN",
      status: tokenValid ? "ok" : "error",
      detail: tokenValid
        ? "Formato valido; validità remota non verificata."
        : "Configurazione assente o formato non valido.",
    },
    {
      id: "telegram-user",
      label: "Telegram · ALLOWED_USER_ID",
      status: userValid ? "ok" : "error",
      detail: userValid
        ? "Identificativo numerico valido."
        : "Configurazione assente o identificativo non valido.",
    },
    {
      id: "telegram-chats",
      label: "Telegram · ALLOWED_CHAT_IDS",
      status: chatsValid ? "ok" : "error",
      detail: chatsValid
        ? "Configurazione locale valida (gruppi facoltativi)."
        : "Elenco di identificativi non valido.",
    },
    {
      id: "groq",
      label: "Trascrizione Groq",
      status: env.GROQ_API_KEY?.trim() ? "ok" : groqDisabledStatus,
      detail: env.GROQ_API_KEY?.trim()
        ? "Chiave presente; validità remota non verificata."
        : groqDisabledDetail,
    },
  ];
  checks.push(
    ...(await Promise.all([
      directoryCheck("projects", "Progetti", options.projectsDir, true),
      directoryCheck("data", "Archivio dati", dataDir, false),
      directoryCheck(
        "attachments",
        "Archivio allegati precedente",
        attachmentsDir,
        false
      ),
      diskCheck("disk-projects", "Spazio progetti", options.projectsDir),
      diskCheck("disk-data", "Spazio dati", dataDir),
      diskCheck(
        "disk-attachments",
        "Spazio allegati precedenti",
        attachmentsDir
      ),
    ]))
  );
  checks.push({
    id: "project-attachments",
    label: "Allegati nuovi",
    status: "info",
    detail:
      "Salvati in telegram dentro il progetto selezionato. I permessi di ogni singolo progetto non sono verificati da questo controllo generale.",
  });
  const probe = dependencies.probeCommand ?? probeCommand;
  checks.push(
    ...(await Promise.all(
      ["bun", "git", "claude", "codex"].map(
        async (command): Promise<DiagnosticCheck> => {
          const installed = await probe(command, env).catch(() => false);
          const provider = command === "claude" || command === "codex";
          const unavailableStatus = provider ? "warning" : "error";
          return {
            id: `cli-${command}`,
            label: `Strumento ${command}`,
            status: installed ? "ok" : unavailableStatus,
            detail: installed
              ? `Disponibile (--version).${provider ? " Autenticazione non verificata." : ""}`
              : "Non disponibile o controllo versione fallito entro 3 secondi.",
          };
        }
      )
    ))
  );
  if (
    checks
      .filter((check) => check.id === "cli-claude" || check.id === "cli-codex")
      .every((check) => check.status !== "ok")
  ) {
    checks.push({
      id: "providers",
      label: "Assistenti",
      status: "error",
      detail: "Nessuno strumento assistente disponibile.",
    });
  }
  return {
    checks,
    hasBlockers: checks.some((check) => check.status === "error"),
  };
}

export function formatDiagnostics(report: DiagnosticReport): string {
  const markers = {
    ok: "OK",
    warning: "AVVISO",
    error: "ERRORE",
    info: "INFO",
  };
  return [
    "Diagnostica locale · controlli in sola lettura",
    ...report.checks.map(
      (check) => `[${markers[check.status]}] ${check.label}: ${check.detail}`
    ),
    report.hasBlockers
      ? "Esito: correggere gli errori indicati."
      : "Esito: nessun impedimento locale rilevato.",
  ].join("\n");
}
