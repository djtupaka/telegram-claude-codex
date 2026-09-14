import { spawn, spawnSync } from "bun";
import { Option } from "effect";
import { stopAll } from "./agent";
import { getProvider } from "./agent/registry";
import {
  cleanupStaleState,
  startBotOperations,
  stopBotOperations,
} from "./bot";
import { AppConfig } from "./config";
import { runtime } from "./runtime";
import { DEFAULT_PROVIDER, loadPersistedState } from "./state";
import { BotService } from "./telegram/bot-service";
import { collectRuntimeVersions } from "./version-info";

/** Warn (but never block startup) if the Codex CLI is missing or not logged in */
const checkCodexAvailable = async () => {
  try {
    const proc = spawn({
      cmd: ["codex", "login", "status"],
      stdout: "ignore",
      stderr: "ignore",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      console.warn(
        "Codex CLI present but not logged in — /provider Codex will fail. Run `codex login`."
      );
    }
  } catch {
    console.warn(
      "Codex CLI not found — /provider Codex unavailable. Install codex to enable it."
    );
  }
};

const CLEANUP_INTERVAL = 3 * 60 * 60 * 1000;

// Boot config through the runtime — fails fast on missing/invalid env, parity
// with the old inline process.exit checks. Secrets stay redacted.
const cfg = await runtime.runPromise(AppConfig);
const { bot } = await runtime.runPromise(BotService);
const userId = cfg.allowedUserId;
const revisionResult = spawnSync(["git", "rev-parse", "--short=12", "HEAD"], {
  cwd: new URL("..", import.meta.url).pathname,
  stderr: "ignore",
});
const revision =
  revisionResult.exitCode === 0
    ? revisionResult.stdout.toString().trim()
    : "non disponibile";

bot.catch((err) => {
  console.error("Bot error:", err);
});

let shuttingDown = false;
let cleanupTimer: ReturnType<typeof setInterval> | undefined;
const shutdown = async () => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log("Shutting down...");
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
  }
  stopBotOperations(bot);
  await stopAll();
  // Disposing the runtime runs BotService's finalizer (bot.stop()) exactly once.
  await runtime.dispose();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

bot.start({
  onStart: () => {
    startBotOperations(bot);
    console.log(`Bot started revision ${revision}`);
    collectRuntimeVersions()
      .then((versions) =>
        console.log(`Runtime versions: ${JSON.stringify(versions)}`)
      )
      .catch(() => undefined);
    // Auth mode is silently flipped by ANTHROPIC_API_KEY presence: absent =>
    // on-disk subscription login (~/.claude); present => metered API pricing.
    console.log(
      Option.isSome(cfg.anthropicApiKey)
        ? "Agent auth: ANTHROPIC_API_KEY (API pricing)"
        : "Agent auth: subscription login (~/.claude)"
    );
    checkCodexAvailable();
    cleanupTimer = setInterval(cleanupStaleState, CLEANUP_INTERVAL);
    const commands = [
      {
        command: "menu",
        description: "Menu interattivo: progetti, attività e impostazioni",
      },
      {
        command: "projects",
        description: "Scegli il progetto su cui lavorare",
      },
      { command: "provider", description: "Scegli tra Claude e Codex" },
      { command: "model", description: "Scegli il modello AI" },
      { command: "effort", description: "Imposta il livello di ragionamento" },
      {
        command: "history",
        description: "Riprendi una conversazione precedente",
      },
      { command: "new", description: "Inizia una nuova conversazione" },
      { command: "stop", description: "Interrompi il lavoro in corso" },
      {
        command: "status",
        description: "Mostra progetto, impostazioni e attività",
      },
      {
        command: "permessi",
        description: "Approva ogni strumento o esegui automaticamente",
      },
      { command: "stats", description: "Tempi, costi disponibili ed esiti" },
      { command: "riepilogo", description: "Aggiorna il riepilogo fissato" },
      { command: "programma", description: "Pianifica un lavoro" },
      { command: "programmi", description: "Elenco lavori programmati" },
      { command: "annulla_programma", description: "Annulla un programma" },
      { command: "eventi", description: "Collega le notifiche dei servizi" },
      { command: "branch", description: "Mostra il ramo Git corrente" },
      { command: "pr", description: "Elenca le richieste di modifica aperte" },
      {
        command: "diagnostica",
        description: "Verifica configurazione, assistenti e spazio disco",
      },
      {
        command: "allegati",
        description: "Cerca e gestisci gli allegati del progetto",
      },
      {
        command: "preferenze",
        description: "Impostazioni preferite per i nuovi argomenti",
      },
      { command: "lavori", description: "Lavori in corso e messaggi in coda" },
      {
        command: "aggiornamenti",
        description: "Versione, backup e ripristino del bot",
      },
      {
        command: "timeout",
        description: "Disattiva il limite o imposta i minuti di esecuzione",
      },
      { command: "help", description: "Guida ai comandi disponibili" },
      {
        command: "compose",
        description: "Raccogli più messaggi da inviare insieme",
      },
      { command: "send", description: "Invia i messaggi raccolti" },
      { command: "cancel", description: "Annulla la raccolta dei messaggi" },
      {
        command: "nuova",
        description: "Gruppo: scegli un progetto e apri un argomento",
      },
      {
        command: "nuovo_progetto",
        description: "Gruppo: crea una cartella progetto su Ubuntu",
      },
      { command: "chiudi", description: "Gruppo: archivia questo argomento" },
      {
        command: "elenco",
        description: "Gruppo: mostra gli argomenti dei progetti",
      },
    ];
    const scopes = [
      { type: "default" as const },
      { type: "all_private_chats" as const },
      { type: "all_group_chats" as const },
      { type: "all_chat_administrators" as const },
    ];
    Promise.all(
      scopes.map((scope) => bot.api.setMyCommands(commands, { scope }))
    ).catch((e) => console.error("Failed to set bot commands:", e));
    const persisted = loadPersistedState();
    const providerId = persisted?.activeProvider ?? DEFAULT_PROVIDER;
    let providerName: string = providerId;
    try {
      providerName = getProvider(providerId).displayName;
    } catch {
      providerName = providerId;
    }
    bot.api
      .sendMessage(
        userId,
        `Bot avviato il ${new Date().toLocaleString("it-IT", { timeZone: "Europe/Rome" })}\nAssistente: ${providerName}\nRevisione: ${revision}`,
        { reply_markup: { remove_keyboard: true } }
      )
      .catch((e) => console.error("Failed to send startup message:", e));
  },
});
