import { lstat, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export interface SetupOptions {
  allowedChatIds?: string;
  directory: string;
  dryRun?: boolean;
  groqApiKey?: string;
  projectsDir: string;
  token: string;
  userId: string;
}
export interface SetupResult {
  dryRun: boolean;
  envPath: string;
  projectsDir: string;
}

const TOKEN = /^\d+:[A-Za-z0-9_-]+$/;
const GROUP_ID = /^-[1-9]\d*$/;
const USER_ID = /^[1-9]\d*$/;
const UNSAFE_ENV = /[\r\n\0"\\$`]/;

export async function setupInstallation(
  options: SetupOptions
): Promise<SetupResult> {
  if (!TOKEN.test(options.token)) {
    throw new Error("Token Telegram non valido.");
  }
  if (
    !(
      USER_ID.test(options.userId) &&
      Number.isSafeInteger(Number(options.userId))
    )
  ) {
    throw new Error("ID utente Telegram non valido.");
  }
  if (
    !isAbsolute(options.projectsDir) ||
    UNSAFE_ENV.test(options.projectsDir)
  ) {
    throw new Error(
      "PROJECTS_DIR deve essere un percorso assoluto senza caratteri di controllo o espansione."
    );
  }
  if (UNSAFE_ENV.test(options.groqApiKey ?? "")) {
    throw new Error("Chiave vocale non valida.");
  }
  const groupIds = options.allowedChatIds?.trim()
    ? options.allowedChatIds.split(",").map((id) => id.trim())
    : [];
  if (
    groupIds.some(
      (id) => !(GROUP_ID.test(id) && Number.isSafeInteger(Number(id)))
    )
  ) {
    throw new Error(
      "ID gruppo non valido: usare interi negativi separati da virgole."
    );
  }
  const envPath = join(resolve(options.directory), ".env");
  try {
    await lstat(envPath);
    throw new Error("Il file .env esiste già: configurazione conservata.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const result = {
    envPath,
    projectsDir: resolve(options.projectsDir),
    dryRun: options.dryRun ?? false,
  };
  if (result.dryRun) {
    return result;
  }
  const content = [
    `BOT_TOKEN="${options.token}"`,
    `ALLOWED_USER_ID=${options.userId}`,
    `PROJECTS_DIR="${result.projectsDir}"`,
    ...(groupIds.length ? [`ALLOWED_CHAT_IDS=${groupIds.join(",")}`] : []),
    `GROQ_API_KEY="${options.groqApiKey ?? ""}"`,
    "",
  ].join("\n");
  await mkdir(resolve(options.directory), { recursive: true, mode: 0o700 });
  await writeFile(envPath, content, { flag: "wx", mode: 0o600 });
  await mkdir(result.projectsDir, { recursive: true, mode: 0o700 });
  return result;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  if (args.some((arg) => arg !== "--dry-run" && arg !== "--interactive")) {
    console.error(
      "Uso: bun run scripts/setup.ts [--interactive] [--dry-run]. Configurare SETUP_BOT_TOKEN, SETUP_USER_ID e SETUP_PROJECTS_DIR nell'ambiente."
    );
    process.exitCode = 1;
  } else {
    try {
      const defaultProjectsDir = join(
        process.env.HOME ?? process.cwd(),
        "projects"
      );
      const { runSetupWizard, terminalPrompt } = await import("./setup-wizard");
      const result = args.includes("--interactive")
        ? await runSetupWizard({
            directory: process.cwd(),
            defaultProjectsDir,
            dryRun,
            prompt: terminalPrompt,
          })
        : await setupInstallation({
            directory: process.cwd(),
            token:
              process.env.SETUP_BOT_TOKEN ?? (dryRun ? "123456:dry-run" : ""),
            userId: process.env.SETUP_USER_ID ?? (dryRun ? "123456" : ""),
            projectsDir:
              process.env.SETUP_PROJECTS_DIR ??
              join(process.env.HOME ?? process.cwd(), "projects"),
            groqApiKey: process.env.SETUP_GROQ_API_KEY,
            allowedChatIds: process.env.SETUP_ALLOWED_CHAT_IDS,
            dryRun,
          });
      if (result) {
        console.log(
          `${result.dryRun ? "Simulazione, nessun file scritto" : "Configurazione creata"}: ${result.envPath}`
        );
        console.log(`Cartella progetti: ${result.projectsDir}`);
        if (!result.dryRun) {
          console.log(
            "Accesso provider con lo stesso utente di sistema: avviare claude e completare il login; per Codex eseguire codex login. Il provider iniziale è Claude; usare /provider per cambiarlo dopo l'avvio."
          );
          console.log(
            "Poi eseguire bun run doctor e bun run start. Guida: docs/INSTALLAZIONE_IT.md"
          );
        }
      } else {
        console.log("Configurazione annullata, nessun file scritto.");
        process.exitCode = 0;
      }
    } catch (error) {
      console.error(
        error instanceof Error ? error.message : "Configurazione non riuscita."
      );
      process.exitCode = 1;
    }
  }
}
