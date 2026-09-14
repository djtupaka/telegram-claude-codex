import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface UpdateReceipt {
  backup: string;
  checks: string[];
  from: string;
  mainPid: number;
  operation: "apply" | "rollback";
  reason?: string;
  status: "prepared" | "installed" | "success" | "failed";
  timestamp: string;
  to: string;
}
export interface UpdateStatus {
  branch: string;
  commit: string;
  receipt?: UpdateReceipt;
}
export function updateDirectory(directory: string): string {
  const key = createHash("sha256")
    .update(resolve(directory))
    .digest("hex")
    .slice(0, 16);
  return join(homedir(), ".local", "state", "dev-bot-updates", key);
}
export async function readUpdateStatus(
  directory: string
): Promise<UpdateStatus> {
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new Error("Versione Git non disponibile.");
    }
    return new TextDecoder().decode(result.stdout).trim();
  };
  const status: UpdateStatus = {
    commit: git(["rev-parse", "HEAD"]),
    branch: git(["branch", "--show-current"]),
  };
  try {
    status.receipt = JSON.parse(
      await readFile(join(updateDirectory(directory), "latest.json"), "utf8")
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error("Ricevuta aggiornamento non leggibile.");
    }
  }
  return status;
}
export function formatUpdateStatus(status: UpdateStatus): string {
  const receipt = status.receipt;
  const operations = {
    apply: "aggiornamento",
    rollback: "ritorno alla versione precedente",
  };
  const states = {
    prepared: "backup verificato",
    installed: "codice installato, avvio da confermare",
    success: "avvio confermato",
    failed: "non riuscito",
  };
  return [
    `Codice nel checkout: ${status.commit.slice(0, 12)} (${status.branch || "senza ramo"}).`,
    receipt
      ? `Ultima operazione: ${operations[receipt.operation]}, ${states[receipt.status]}, ${receipt.timestamp}.`
      : "Nessun aggiornamento gestito registrato.",
    "Da terminale nella cartella del bot: bun run scripts/managed-update.ts check",
    "Per applicare o tornare indietro: terminare le sessioni, arrestare il servizio, quindi usare apply o rollback.",
  ].join("\n");
}
