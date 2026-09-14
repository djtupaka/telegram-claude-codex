import { readdirSync, readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { Effect } from "effect";
import { Api, Bot, Context, InlineKeyboard } from "grammy";
import {
  clearSessionCache,
  getActiveRunSnapshot,
  getCapabilities,
  getDefaultEffort,
  getEffortLevels,
  getModels,
  getSessionProject,
  hasActiveProcess,
  listAllSessions,
  noteAgentProgress,
  runAgent,
  stopAgent,
} from "./agent";
import { runWithAstraStartupFallback } from "./agent/astra-fallback";
import { getCodexContextWarning } from "./agent/codex-history";
import { classifyOutcome, runOutcomeOf } from "./agent/errors";
import { resolveEffortChoice, resolveModelChoice } from "./agent/preferences";
import { getProvider, listProviders } from "./agent/registry";
import { formatActiveRunTiming } from "./agent/run-status";
import {
  clearSession,
  clearSessionIfMatches,
  countSessions,
  getSession,
  setSession,
} from "./agent/session-store";
import type { ProviderId } from "./agent/types";
import { storeAttachment } from "./attachments";
import type { AutomationTarget } from "./automations";
import { installAutomations } from "./bot-automations";
import { type ControlTarget, installBotControls } from "./bot-controls";
import { installDevMenu, menuReplyTransformer, menuShortcut } from "./dev-menu";
import { collectDiagnostics, formatDiagnostics } from "./diagnostics";
import {
  getCurrentBranch,
  getGitHubUrl,
  listBranches,
  listOpenPRs,
} from "./git";
import {
  clipError,
  Observability,
  RUN_EVENT_MARKER,
  RUN_STARTED_MARKER,
  RunEvent,
  RunStartedEvent,
  UPDATE_RECEIVED_MARKER,
  UpdateReceivedEvent,
} from "./observability";
import { createProjectFolder } from "./project-folders";
import { runtime } from "./runtime";
import {
  installThreadTransformer,
  resolveScope,
  type Scope,
  sessionProjectKey,
} from "./scope";
import {
  DEFAULT_PROVIDER,
  loadPersistedState,
  setActiveProject,
  setActiveProvider,
  setEffort,
  setModel,
  topicOps,
} from "./state";
import {
  type StreamResult,
  sendRichMarkdown,
  splitText,
  streamToTelegram,
} from "./telegram";
import { createTopicSession, projectLabel } from "./topics";
import { TranscribeService } from "./transcribe";
import { BOT_VERSION } from "./version-info";

/**
 * Promise-facing bridge to the Effect TranscribeService: resolves the spoken
 * text or rejects (TranscriptionError) so the existing voice handlers keep their
 * try/catch shape.
 */
const transcribeAudio = (buffer: Buffer, filename: string) =>
  runtime.runPromise(
    Effect.flatMap(TranscribeService, (t) => t.transcribe(buffer, filename))
  );

type UpdateKind = ConstructorParameters<typeof UpdateReceivedEvent>[0]["kind"];

/** Classify an authorized update without retaining any user-supplied content. */
const updateKind = (ctx: Context): UpdateKind => {
  const message = ctx.message;
  if (message?.text?.startsWith("/")) {
    return "command";
  }
  if (message?.text) {
    return "text";
  }
  if (message?.voice) {
    return "voice";
  }
  if (message?.photo) {
    return "photo";
  }
  if (message?.document) {
    return "document";
  }
  return "other";
};

/** Best-effort bridge for prompt-free lifecycle markers. */
const emitLifecycleEvent = async (
  event: RunStartedEvent | UpdateReceivedEvent
) => {
  try {
    await runtime.runPromise(
      Effect.flatMap(Observability, (o) => o.recordLifecycle(event))
    );
  } catch {
    // Observability must never delay or break Telegram handling.
  }
};

/** Mutable outcome/economics accumulator for a single prompt run. */
interface RunRecord {
  costUsd: number | null;
  durationMs: number | null;
  errorClass?: string;
  errorMessage?: string;
  outcome:
    | "done"
    | "errored"
    | "interrupted"
    | "timeout"
    | "already_running"
    | "at_capacity";
  sessionId: string | null;
  totalTokens: number | null;
  turns: number | null;
}

/** Immutable per-run context captured before streaming starts. */
interface RunEventMeta {
  project: string;
  promptChars: number;
  provider: string;
  queueDepth: number;
  runId: string;
  userId: number;
}

/**
 * Fold a completed stream result into the run record: economics are populated
 * only when the provider reported them, and an in-stream error (surfaced on the
 * result rather than thrown) is mapped to its outcome, nulling economics on any
 * degraded (non-errored) outcome.
 */
const applyResultEconomics = (result: StreamResult, rec: RunRecord) => {
  rec.costUsd = result.cost ?? null;
  rec.turns = result.turns ?? null;
  rec.totalTokens = result.totalTokens ?? null;
  rec.durationMs = result.durationMs ?? null;
  if (!result.errorClass) {
    if (result.errorMessage) {
      rec.outcome = "errored";
      rec.errorClass = "ProviderError";
      rec.errorMessage = clipError(result.errorMessage);
    }
    return;
  }
  rec.outcome = runOutcomeOf(result.errorClass);
  if (rec.outcome === "errored") {
    rec.errorClass = result.errorClass._tag;
    rec.errorMessage = clipError(classifyOutcome(result.errorClass).copy);
  } else {
    rec.costUsd = null;
    rec.turns = null;
    rec.totalTokens = null;
    rec.durationMs = null;
  }
};

/**
 * Emit the single wide event for a run. NULLs economics on any non-terminal
 * outcome, then bridges into the Effect runtime; a rejected bridge is swallowed
 * so observability can never break a user's chat.
 */
const emitRunEvent = async (rec: RunRecord, meta: RunEventMeta) => {
  if (rec.outcome !== "done" && rec.outcome !== "errored") {
    rec.costUsd = null;
    rec.turns = null;
    rec.totalTokens = null;
    rec.durationMs = null;
  }
  try {
    // RunEvent construction validates synchronously and can throw; keep it
    // inside the guard so the emit is fully best-effort on every path.
    const evt = new RunEvent({
      ts: new Date().toISOString(),
      event: RUN_EVENT_MARKER,
      runId: meta.runId,
      userId: meta.userId,
      provider: meta.provider,
      project: meta.project,
      sessionId: rec.sessionId,
      promptChars: meta.promptChars,
      outcome: rec.outcome,
      costUsd: rec.costUsd,
      turns: rec.turns,
      totalTokens: rec.totalTokens,
      durationMs: rec.durationMs,
      queueDepth: meta.queueDepth,
      errorClass: rec.errorClass,
      errorMessage: rec.errorMessage,
      version: BOT_VERSION,
      host: hostname(),
    });
    await runtime.runPromise(
      Effect.flatMap(Observability, (o) => o.recordRun(evt))
    );
  } catch {
    // swallow: observability is best-effort and must never break a chat
  }
};

interface QueuedMessage {
  ctx: Context;
  prompt: string;
}

interface ComposeMessage {
  content: string;
  type: "text" | "voice" | "forwarded" | "file" | "photo";
}

interface PendingPlan {
  planPath: string;
  projectPath: string;
  sessionId?: string;
}

interface UserState {
  activeProject: string;
  activeProvider: ProviderId;
  /** Chat this state belongs to (private chat or group). */
  chatId: number;
  composeMessages?: ComposeMessage[];
  composeStatusMessageId?: number;
  efforts: Partial<Record<ProviderId, string>>;
  models: Partial<Record<ProviderId, string>>;
  pendingPlan?: PendingPlan;
  queue: QueuedMessage[];
  queueStatusMessageId?: number;
  /** Run-registry key: one active run per scope (private chat or topic). */
  runKey: string;
  /** Set for forum topics: persistence goes to topics.json, sessions get suffixed. */
  scopeKey?: string;
  threadId?: number;
}

/** Return a read-only context warning only for the selected Codex session. */
const statusSessionWarning = async (state: UserState) => {
  if (state.activeProvider !== "codex") {
    return "";
  }
  try {
    const sessionId = await runtime.runPromise(
      getSession(
        sessionProjectKey(state.scopeKey, state.activeProject),
        state.activeProvider
      )
    );
    const warning = sessionId ? getCodexContextWarning(sessionId) : undefined;
    return warning ? `\n${warning}` : "";
  } catch {
    return "";
  }
};

const scopeStates = new Map<string, UserState>();
/** Scope resolved by the routing middleware, keyed by the update object. */
const scopes = new WeakMap<object, Scope>();
const HISTORY_PAGE_SIZE = 5;
const PROJECT_PAGE_SIZE = 20;
const MAX_COMPOSE_MESSAGES = 50;
const MEDIA_GROUP_DEBOUNCE_MS = 500;

interface MediaGroupEntry {
  caption: string;
  ctx: Context;
  photos: { fileId: string; filename: string }[];
  timer: ReturnType<typeof setTimeout>;
}

/** Pending media groups keyed by media_group_id */
const mediaGroupBuffers = new Map<string, MediaGroupEntry>();

/** Escape HTML special characters for Telegram */
function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** No-op that swallows errors from best-effort Telegram calls (edits/deletes/pins) */
const swallow = () => {
  // Best-effort operations: failures here are non-critical and intentionally ignored.
};

/** Chat id from context; message/callback updates always carry a chat */
const requireChat = (ctx: Context) => {
  if (!ctx.chat) {
    throw new Error("No chat context");
  }
  return ctx.chat.id;
};

/** Human-readable label for the active project (general / basename / none) */
const describeProject = (activeProject: string, projectsDir: string) => {
  if (!activeProject) {
    return "(nessuno)";
  }
  return activeProject === projectsDir ? "Generale" : basename(activeProject);
};

type ForwardOrigin = NonNullable<
  NonNullable<Context["message"]>["forward_origin"]
>;

/** Display name for a forwarded message origin */
const forwardSenderName = (origin: ForwardOrigin) => {
  if (origin.type === "user") {
    return origin.sender_user.first_name;
  }
  if (origin.type === "channel") {
    return origin.chat.title;
  }
  if (origin.type === "hidden_user") {
    return origin.sender_user_name;
  }
  return "unknown";
};

/** Unpin existing pins and pin the given edited-message result (best-effort) */
const repinMessage = async (
  ctx: Context,
  chatId: number,
  msg: Awaited<ReturnType<Context["editMessageText"]>>
) => {
  if (ctx.msg?.is_topic_message) {
    return; // topic name already states project and provider; pins are chat-wide
  }
  await ctx.api.unpinAllChatMessages(chatId).catch(swallow);
  const pinnedId =
    typeof msg === "object" && "message_id" in msg ? msg.message_id : undefined;
  if (pinnedId) {
    await ctx.api
      .pinChatMessage(chatId, pinnedId, { disable_notification: true })
      .catch(swallow);
  }
};

const PROVIDER_CALLBACK_RE = /^provider:(.+)$/;
const MODEL_CALLBACK_RE = /^model:(.+)$/;
const EFFORT_CALLBACK_RE = /^effort:(.+)$/;
const PROJECTS_PAGE_RE = /^projects:(\d+)$/;
const PROJECT_CALLBACK_RE = /^project:(.+)$/;
const COMPOSE_SEND_RE = /^compose_send:(\d+)$/;
const COMPOSE_CANCEL_RE = /^compose_cancel:(\d+)$/;
const HISTORY_PAGE_RE = /^history:(\d+)$/;
const SESSION_CALLBACK_RE = /^session:(.+)$/;
const FORCE_SEND_RE = /^force_send:(\d+)$/;
const CLEAR_QUEUE_RE = /^clear_queue:(\d+)$/;
const PLAN_NEW_RE = /^plan_new:(\d+)$/;
const PLAN_RESUME_RE = /^plan_resume:(\d+)$/;
const PLAN_MODIFY_RE = /^plan_modify:(\d+)$/;
const PLAN_CANCEL_RE = /^plan_cancel:(\d+)$/;
const NT_PAGE_RE = /^nt_projects:(\d+)$/;
const NT_PROJECT_RE = /^nt_project:(.+)$/;
const NT_PROVIDER_RE = /^nt_provider:([^:]+):(claude|codex)$/;
const COMMAND_TAIL_RE = /[\s@]/;
const WHITESPACE_RE = /\s+/;

/** Dismiss keyboards left by older bot versions. Navigation lives in /menu. */
const removeReplyKeyboard = { remove_keyboard: true } as const;

/** Extract reply-to-message text and prepend it as context (skip bot's own messages) */
function buildPromptWithReplyContext(
  ctx: Context,
  userText: string,
  botId?: number
) {
  const replyText = ctx.message?.reply_to_message?.text;
  if (!replyText) {
    return userText;
  }
  if (botId && ctx.message?.reply_to_message?.from?.id === botId) {
    return userText;
  }
  const truncated =
    replyText.length > 2000 ? `${replyText.slice(0, 2000)}...` : replyText;
  return `[Replying to: ${truncated}]\n\n${userText}`;
}

/** Extract user ID from context (safe after access-control middleware) */
function getUserId(ctx: Context) {
  if (!ctx.from) {
    throw new Error("No user context");
  }
  return ctx.from.id;
}

/** Scope of the current update (set by the routing middleware). */
function getScope(ctx: Context): Scope {
  const scope = scopes.get(ctx.update);
  if (!scope) {
    throw new Error("No scope resolved for update");
  }
  return scope;
}

/** Get or create the session state for a scope (private chat or forum topic). */
function getState(scope: Scope): UserState {
  let state = scopeStates.get(scope.key);
  if (!state) {
    if (scope.kind === "topic") {
      const record = topicOps.get(scope.key);
      state = {
        activeProvider: record?.activeProvider ?? DEFAULT_PROVIDER,
        activeProject: record?.activeProject ?? "",
        models: record?.models ?? {},
        efforts: record?.efforts ?? {},
        queue: [],
        runKey: scope.key,
        scopeKey: scope.key,
        chatId: scope.chatId,
        threadId: scope.threadId,
      };
    } else {
      const persisted = loadPersistedState();
      state = {
        activeProvider: persisted?.activeProvider ?? DEFAULT_PROVIDER,
        activeProject: persisted?.activeProject ?? "",
        models: persisted?.models ?? {},
        efforts: persisted?.efforts ?? {},
        queue: [],
        runKey: scope.key,
        chatId: scope.chatId,
      };
    }
    scopeStates.set(scope.key, state);
  }
  return state;
}

/** Resolve the active provider's display name (falls back to its id) */
function activeProviderName(state: UserState) {
  return (
    listProviders().find((p) => p.id === state.activeProvider)?.displayName ??
    state.activeProvider
  );
}

/** Whether the active provider supports plan mode (gates all plan UI/affordances) */
function planModeEnabled(state: UserState) {
  return getCapabilities(state.activeProvider).planMode;
}

/** Active pending plan, or undefined when the active provider lacks plan mode */
function activePendingPlan(state: UserState) {
  return planModeEnabled(state) ? state.pendingPlan : undefined;
}

/** List project directories */
function listProjects(projectsDir: string) {
  try {
    return readdirSync(projectsDir)
      .filter((name) => {
        try {
          return statSync(join(projectsDir, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

/** Clears stale compose state and logs memory usage */
export function cleanupStaleState() {
  for (const [, state] of scopeStates) {
    if (state.composeMessages && state.queue.length === 0) {
      state.composeMessages = undefined;
      state.composeStatusMessageId = undefined;
    }
  }
  for (const provider of listProviders()) {
    clearSessionCache(provider.id);
  }
  const mem = process.memoryUsage();
  console.log(
    `[cleanup] rss=${(mem.rss / 1024 / 1024).toFixed(1)}MB heap=${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB`
  );
}

const botOperations = new WeakMap<Bot, { start(): void; stop(): void }>();
export const startBotOperations = (bot: Bot) => botOperations.get(bot)?.start();
export const stopBotOperations = (bot: Bot) => botOperations.get(bot)?.stop();

/** Create and configure the bot */
export function createBot(
  token: string,
  allowedUserId: number,
  projectsDir: string,
  inactivityWarningMs = 1_200_000,
  allowedChatIds: readonly number[] = []
) {
  const bot = new Bot(token);
  bot.api.config.use(menuReplyTransformer);
  const allowedChats = new Set(allowedChatIds);
  const deniedChatsLogged = new Set<number>();
  /** Commands usable in a group's General area (everything else needs a topic). */
  const controlCommands = new Set([
    "start",
    "menu",
    "help",
    "nuova",
    "nuovo_progetto",
    "elenco",
    "diagnostica",
  ]);
  /** Whether an update in the General area may proceed to the handlers. */
  const controlAllowed = (ctx: Context) => {
    const callbackData = ctx.callbackQuery?.data ?? "";
    if (callbackData.startsWith("nt_") || callbackData.startsWith("menu:")) {
      return true;
    }
    const text = ctx.message?.text ?? "";
    if (text === "☰ Menu") {
      return true;
    }
    const cmd = text.startsWith("/")
      ? text.slice(1).split(COMMAND_TAIL_RE, 1)[0]
      : "";
    return Boolean(cmd && controlCommands.has(cmd));
  };
  const logDenied = (chatId: number) => {
    if (!deniedChatsLogged.has(chatId)) {
      deniedChatsLogged.add(chatId);
      console.log(`Ignoring chat ${chatId}: not in ALLOWED_CHAT_IDS`);
    }
  };

  // Access control middleware
  const botId = Number.parseInt(token.split(":")[0] ?? "", 10);
  bot.use(async (ctx, next) => {
    if (!ctx.from || ctx.from.id === botId) {
      return;
    }
    if (ctx.from.id !== allowedUserId) {
      console.log(
        `Auth rejected: from=${ctx.from.id} allowed=${allowedUserId}`
      );
      await ctx.reply("Utente Telegram non autorizzato.");
      return;
    }
    await next();
  });

  // Scope routing: private chat (legacy), forum topic (own session), group
  // General area (control only) or denied. Topic scopes get a context-scoped
  // API transformer so every reply lands inside the topic.
  bot.use(async (ctx, next) => {
    const scope = resolveScope(ctx, allowedChats);
    if (!scope) {
      return;
    }
    if (scope.kind === "denied") {
      logDenied(scope.chatId);
      return;
    }
    scopes.set(ctx.update, scope);
    installThreadTransformer(ctx, scope);
    if (scope.kind === "control") {
      if (controlAllowed(ctx)) {
        return next();
      }
      if (ctx.message) {
        await ctx.reply(
          "Apri il menu per scegliere un progetto o creare un argomento. Dentro l'argomento puoi scrivere per lavorare.",
          { reply_markup: menuShortcut() }
        );
      }
      return;
    }
    await next();
  });

  // Authorized-update receipt marker: ids and kind only, never message content.
  bot.use(async (ctx, next) => {
    if (ctx.from) {
      await emitLifecycleEvent(
        new UpdateReceivedEvent({
          ts: new Date().toISOString(),
          event: UPDATE_RECEIVED_MARKER,
          updateId: ctx.update.update_id,
          userId: ctx.from.id,
          kind: updateKind(ctx),
          version: BOT_VERSION,
          host: hostname(),
        })
      );
    }
    await next();
  });

  let closing = false;
  const reservedRuns = new Set<string>();
  const scopeControllers = new Map<string, AbortController>();
  const stopScope = (key: string, reason: Parameters<typeof stopAgent>[1]) => {
    const controller = scopeControllers.get(key);
    controller?.abort();
    return stopAgent(key, reason) || Boolean(controller);
  };
  const busy = (runKey: string) =>
    reservedRuns.has(runKey) || hasActiveProcess(runKey);
  const targetForState = (scope: Scope, state: UserState): ControlTarget => ({
    scopeKey: scope.key,
    runKey: state.runKey,
    chatId: scope.chatId,
    threadId: scope.threadId,
    userId: scope.userId,
    project: state.activeProject || projectsDir,
    provider: state.activeProvider,
    model: resolveModelChoice(
      getProvider(state.activeProvider),
      state.models[state.activeProvider]
    ),
    effort: resolveEffortChoice(
      getProvider(state.activeProvider),
      state.efforts[state.activeProvider]
    ),
    branch: state.activeProject ? getCurrentBranch(state.activeProject) : null,
  });
  const getTarget = (ctx: Context) => {
    const scope = getScope(ctx);
    if (scope.kind !== "private" && scope.kind !== "topic") {
      throw new Error("Apri un argomento per usare questo comando.");
    }
    return targetForState(scope, getState(scope));
  };
  bot.use((ctx, next) => {
    if (ctx.message?.text === "☰ Menu") {
      ctx.message.text = "/menu";
      ctx.message.entities = [{ type: "bot_command", offset: 0, length: 5 }];
    }
    return next();
  });
  const menu = installDevMenu({
    bot,
    context: (ctx) => {
      const scope = getScope(ctx);
      if (scope.kind === "control" || scope.kind === "denied") {
        return { kind: scope.kind };
      }
      const state = getState(scope);
      const target = targetForState(scope, state);
      return {
        kind: scope.kind,
        project: basename(target.project),
        provider: activeProviderName(state),
        model: target.model,
        effort:
          getEffortLevels(state.activeProvider).find(
            (choice) => choice.id === target.effort
          )?.label ?? target.effort,
        running: busy(state.runKey),
        queued: state.queue.length,
        approvalPolicy: controls.store.getSettings(scope.key).approvalPolicy,
      };
    },
    topics: () =>
      Object.entries(topicOps.list()).map(([key, topic]) => ({
        name: topic.name,
        chatId: topic.chatId,
        threadId: topic.threadId,
        running: busy(key),
      })),
    runCommand: async (ctx, command) => {
      const message = ctx.callbackQuery?.message;
      if (!(message?.date && ctx.from) || message.chat.type === "channel") {
        await ctx.reply("Menu non più disponibile. Riaprilo con /menu.");
        return;
      }
      const text = `/${command}`;
      await bot.handleUpdate({
        update_id: ctx.update.update_id,
        message: {
          message_id: message.message_id,
          date: message.date,
          chat: message.chat,
          from: ctx.from,
          text,
          is_topic_message: getScope(ctx).kind === "topic",
          message_thread_id: getScope(ctx).threadId,
          entities: [
            {
              type: "bot_command",
              offset: 0,
              length: text.split(" ")[0]?.length ?? text.length,
            },
          ],
        },
      });
    },
  });
  const controls = installBotControls({
    bot,
    getTarget,
    isBusy: busy,
    activeRunId: (key) => getActiveRunSnapshot(key)?.runId,
  });
  const refreshSummary = (ctx: Context, status?: string) => {
    const target = getTarget(ctx);
    return controls
      .summary(
        target,
        status ?? (busy(target.runKey) ? "In esecuzione" : "Libero")
      )
      .catch(() =>
        console.warn(
          "Riepilogo argomento non aggiornato: verificare permessi Telegram."
        )
      );
  };
  const authorizedAutomationScope = (target: AutomationTarget): Scope => {
    // Saved jobs may outlive a topic or its authorization: recheck at execution.
    const scope: Scope = {
      kind: target.threadId === undefined ? "private" : "topic",
      key: target.scopeKey,
      chatId: target.chatId,
      threadId: target.threadId,
      userId: allowedUserId,
    };
    if (scope.kind === "topic") {
      const saved = topicOps.get(scope.key);
      if (
        !(allowedChats.has(scope.chatId) && saved) ||
        saved.chatId !== scope.chatId ||
        saved.threadId !== scope.threadId ||
        saved.activeProject !== target.project
      ) {
        throw new Error(
          "Argomento del programma non più autorizzato o progetto cambiato."
        );
      }
    } else if (
      scope.chatId !== allowedUserId ||
      scope.key !== `u:${allowedUserId}`
    ) {
      throw new Error("Destinazione del programma non autorizzata.");
    }
    return scope;
  };
  const automations = installAutomations({
    bot,
    getTarget,
    validateTarget: (target) => {
      authorizedAutomationScope(target);
    },
    eventsPort: process.env.EVENTS_PORT
      ? Number(process.env.EVENTS_PORT)
      : undefined,
    eventsToken: process.env.EVENTS_TOKEN,
    isBusy: (key) =>
      busy(key.startsWith("u:") ? key.slice(2) : key) ||
      Boolean(scopeStates.get(key)?.pendingPlan),
    run: async (target: AutomationTarget, prompt, signal, readOnly) => {
      if (closing) {
        throw new Error("Bot in arresto.");
      }
      const scope = authorizedAutomationScope(target);
      const liveState = getState(scope);
      const state = {
        ...liveState,
        activeProject: target.project,
        activeProvider: target.provider,
        models: { [target.provider]: target.model },
        efforts: { [target.provider]: target.effort },
        queue: [],
      };
      if (busy(state.runKey) || liveState.pendingPlan || signal.aborted) {
        throw new Error("Conversazione occupata o programma annullato.");
      }
      const ctx = new Context(
        {
          update_id: 0,
          message: {
            message_id: 0,
            date: Math.floor(Date.now() / 1000),
            text: prompt,
            chat:
              scope.kind === "topic"
                ? { id: scope.chatId, type: "supergroup", title: "Dev" }
                : { id: scope.chatId, type: "private", first_name: "Utente" },
            from: { id: allowedUserId, is_bot: false, first_name: "Utente" },
            is_topic_message: scope.kind === "topic",
            message_thread_id: scope.threadId,
          },
        },
        new Api(token),
        bot.botInfo
      );
      scopes.set(ctx.update, scope);
      installThreadTransformer(ctx, scope);
      reservedRuns.add(state.runKey);
      try {
        await runSinglePrompt(ctx, prompt, state, allowedUserId, {
          signal,
          readOnly,
        });
      } finally {
        reservedRuns.delete(state.runKey);
        scopeControllers.delete(state.runKey);
        const queued = liveState.queue.shift();
        if (queued && !closing) {
          runAndDrain(
            queued.ctx,
            queued.prompt,
            liveState,
            allowedUserId
          ).catch(() => console.error("Ripresa della coda non riuscita."));
        }
      }
    },
  });
  botOperations.set(bot, {
    start: () => automations.start(),
    stop: () => {
      closing = true;
      for (const state of scopeStates.values()) {
        state.queue = [];
      }
      automations.stop();
      controls.stop();
      for (const controller of scopeControllers.values()) {
        controller.abort();
      }
    },
  });
  bot.use(async (ctx, next) => {
    await next();
    const scope = getScope(ctx);
    if (scope.kind === "topic") {
      await refreshSummary(ctx);
    }
  });

  const buttonToCommand: Record<string, string> = {
    Progetti: "/projects",
    Cronologia: "/history",
    Interrompi: "/stop",
    "Nuova sessione": "/new",
    Componi: "/compose",
    // Keep routing keyboards already displayed before the Italian labels.
    Projects: "/projects",
    History: "/history",
    Stop: "/stop",
    New: "/new",
    Compose: "/compose",
  };
  bot.use((ctx, next) => {
    const message = ctx.message;
    if (message?.text && message.text in buttonToCommand) {
      const cmd = buttonToCommand[message.text];
      if (cmd) {
        message.text = cmd;
        message.entities = [
          { type: "bot_command", offset: 0, length: cmd.length },
        ];
      }
    }
    return next();
  });

  // Compose mode interceptor: capture non-command messages when composing
  // Media group photos pass through to the photo handler for batching
  bot.on("message", async (ctx, next) => {
    const state = getState(getScope(ctx));
    if (!state.composeMessages) {
      return next();
    }
    if (ctx.message?.text?.startsWith("/")) {
      return next();
    }
    if (ctx.message?.photo && ctx.message.media_group_id) {
      return next();
    }
    await collectComposeMessage(ctx, state);
  });

  let pendingDiagnostics: Promise<string> | undefined;
  bot.command("diagnostica", async (ctx) => {
    const report =
      pendingDiagnostics ??
      collectDiagnostics({ projectsDir })
        .then(formatDiagnostics)
        .catch(() => "Diagnostica non riuscita. Riprova tra poco.")
        .finally(() => {
          pendingDiagnostics = undefined;
        });
    pendingDiagnostics = report;
    await ctx.reply(await report, { reply_markup: menuShortcut() });
  });

  bot.command("start", async (ctx) => {
    const scope = getScope(ctx);
    if (scope.kind !== "private") {
      await menu.show(ctx);
      return;
    }
    const state = getState(scope);
    const project = state.activeProject || "(nessuno)";
    await ctx.reply(
      `Assistente di sviluppo pronto.\nAssistente: ${activeProviderName(state)}\nProgetto attivo: ${project}\n\nComandi:\n/projects - cambia progetto\n/provider - scegli l’assistente di sviluppo\n/history - riprendi una sessione precedente\n/stop - interrompi l’esecuzione in corso\n/status - stato attuale\n/new - azzera la sessione`,
      { reply_markup: removeReplyKeyboard }
    );
  });

  bot.command("provider", async (ctx) => {
    const state = getState(getScope(ctx));
    const keyboard = new InlineKeyboard();
    for (const provider of listProviders()) {
      const mark = provider.id === state.activeProvider ? "✓ " : "";
      keyboard
        .text(`${mark}${provider.displayName}`, `provider:${provider.id}`)
        .row();
    }
    await ctx.reply("Scegli l’assistente di sviluppo:", {
      reply_markup: keyboard,
    });
  });

  bot.callbackQuery(PROVIDER_CALLBACK_RE, async (ctx) => {
    const chosen = ctx.match?.[1] as ProviderId;
    const provider = listProviders().find((p) => p.id === chosen);
    if (!provider) {
      await ctx.answerCallbackQuery({ text: "Assistente sconosciuto" });
      return;
    }
    const state = getState(getScope(ctx));
    const wasRunning = busy(state.runKey);
    if (wasRunning) {
      stopScope(state.runKey, "switched");
    }
    // setActiveProvider mutates state.activeProvider in place and persists
    setActiveProvider(state, chosen);
    await ctx.answerCallbackQuery({
      text: `Assistente selezionato: ${provider.displayName}`,
    });
    const stoppedSuffix = wasRunning
      ? " L’esecuzione precedente è stata interrotta."
      : "";
    await ctx.editMessageText(
      `Assistente attivo: ${provider.displayName}.${stoppedSuffix}`
    );
  });

  bot.command("model", async (ctx) => {
    const state = getState(getScope(ctx));
    const provider = state.activeProvider;
    const current = state.models[provider] ?? "default";
    const keyboard = new InlineKeyboard();
    for (const choice of getModels(provider)) {
      const mark = choice.id === current ? "✓ " : "";
      keyboard.text(`${mark}${choice.label}`, `model:${choice.id}`).row();
    }
    await ctx.reply(`Scegli un modello per ${activeProviderName(state)}:`, {
      reply_markup: keyboard,
    });
  });

  bot.callbackQuery(MODEL_CALLBACK_RE, async (ctx) => {
    const chosen = ctx.match?.[1] as string;
    const state = getState(getScope(ctx));
    const provider = state.activeProvider;
    const choice = getModels(provider).find((m) => m.id === chosen);
    if (!choice) {
      await ctx.answerCallbackQuery({ text: "Modello sconosciuto" });
      return;
    }
    setModel(state, provider, chosen);
    await ctx.answerCallbackQuery({ text: `Modello: ${choice.label}` });
    await ctx.editMessageText(
      `Modello di ${activeProviderName(state)}: ${choice.label}. Si applica dal prossimo messaggio.`
    );
  });

  bot.command("effort", async (ctx) => {
    const state = getState(getScope(ctx));
    const provider = state.activeProvider;
    const defaultId = getDefaultEffort(provider);
    const current = state.efforts[provider] ?? defaultId;
    const keyboard = new InlineKeyboard();
    for (const choice of getEffortLevels(provider)) {
      const mark = choice.id === current ? "✓ " : "";
      const label =
        choice.id === defaultId
          ? `${choice.label} (predefinito)`
          : choice.label;
      keyboard.text(`${mark}${label}`, `effort:${choice.id}`).row();
    }
    await ctx.reply(
      `Scegli il livello di ragionamento per ${activeProviderName(state)}:`,
      {
        reply_markup: keyboard,
      }
    );
  });

  bot.callbackQuery(EFFORT_CALLBACK_RE, async (ctx) => {
    const chosen = ctx.match?.[1] as string;
    const state = getState(getScope(ctx));
    const provider = state.activeProvider;
    const choice = getEffortLevels(provider).find((e) => e.id === chosen);
    if (!choice) {
      await ctx.answerCallbackQuery({
        text: "Livello di ragionamento sconosciuto",
      });
      return;
    }
    setEffort(state, provider, chosen);
    await ctx.answerCallbackQuery({ text: `Ragionamento: ${choice.label}` });
    await ctx.editMessageText(
      `Livello di ragionamento di ${activeProviderName(state)}: ${choice.label}. Si applica dal prossimo messaggio.`
    );
  });

  /** Build paginated project selection message with inline keyboard */
  function buildProjectsMessage(page: number, projectsDir: string) {
    const projects = listProjects(projectsDir);

    if (projects.length === 0) {
      return null;
    }

    const totalPages = Math.ceil(projects.length / PROJECT_PAGE_SIZE);
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const pageSlice = projects.slice(
      safePage * PROJECT_PAGE_SIZE,
      (safePage + 1) * PROJECT_PAGE_SIZE
    );

    const keyboard = new InlineKeyboard();
    keyboard.text("Generale (tutti i progetti)", "project:__general__").row();
    for (const name of pageSlice) {
      keyboard.text(name, `project:${name}`).row();
    }

    const navRow: { text: string; data: string }[] = [];
    if (safePage > 0) {
      navRow.push({ text: "← Precedenti", data: `projects:${safePage - 1}` });
    }
    if (safePage < totalPages - 1) {
      navRow.push({ text: "Successivi →", data: `projects:${safePage + 1}` });
    }
    if (navRow.length > 0) {
      for (const btn of navRow) {
        keyboard.text(btn.text, btn.data);
      }
      keyboard.row();
    }

    const pageIndicator =
      totalPages > 1 ? ` (${safePage + 1}/${totalPages})` : "";
    return { text: `Scegli un progetto${pageIndicator}:`, keyboard };
  }

  bot.command("projects", async (ctx) => {
    const result = buildProjectsMessage(0, projectsDir);

    if (!result) {
      await ctx.reply(`Nessun progetto trovato in ${projectsDir}`, {
        reply_markup: removeReplyKeyboard,
      });
      return;
    }

    await ctx.reply(result.text, { reply_markup: result.keyboard });
  });

  bot.callbackQuery(PROJECTS_PAGE_RE, async (ctx) => {
    const page = Number.parseInt(ctx.match?.[1] ?? "", 10);
    const result = buildProjectsMessage(page, projectsDir);

    if (!result) {
      await ctx.answerCallbackQuery({ text: "Nessun progetto trovato" });
      return;
    }

    await ctx.editMessageText(result.text, { reply_markup: result.keyboard });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(PROJECT_CALLBACK_RE, async (ctx) => {
    const name = ctx.match?.[1] ?? "";
    const isGeneral = name === "__general__";
    const fullPath = isGeneral ? projectsDir : join(projectsDir, name);
    const displayName = isGeneral ? "Generale (tutti i progetti)" : name;

    if (!isGeneral) {
      try {
        statSync(fullPath);
      } catch {
        await ctx.answerCallbackQuery({ text: "Progetto non trovato" });
        return;
      }
    }

    const state = getState(getScope(ctx));
    const chatId = requireChat(ctx);
    if (busy(state.runKey)) {
      stopScope(state.runKey, "switched");
    }
    setActiveProject(state, fullPath);
    state.queue = [];
    state.pendingPlan = undefined;
    state.composeMessages = undefined;
    await cleanupQueueStatus(state, ctx);
    await cleanupComposeStatus(state, ctx);
    await ctx.answerCallbackQuery({
      text: `Progetto selezionato: ${displayName}`,
    });
    const ghUrl = isGeneral ? null : getGitHubUrl(fullPath);
    const projectLabel = ghUrl
      ? `<a href="${escapeHtml(ghUrl)}">${escapeHtml(displayName)}</a>`
      : escapeHtml(displayName);
    const branch = isGeneral ? null : getCurrentBranch(fullPath);
    const branchSuffix = branch ? ` [${escapeHtml(branch)}]` : "";
    const providerSuffix = ` · ${escapeHtml(activeProviderName(state))}`;
    const msg = await ctx.editMessageText(
      `Progetto attivo: ${projectLabel}${branchSuffix}${providerSuffix}`,
      { parse_mode: "HTML" }
    );
    await repinMessage(ctx, chatId, msg);
  });

  /** Project picker for /nuova (no "General": a topic is always one project). */
  function buildTopicProjectsMessage(page: number) {
    const projects = listProjects(projectsDir);
    const totalPages = Math.max(
      1,
      Math.ceil(projects.length / PROJECT_PAGE_SIZE)
    );
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const pageSlice = projects.slice(
      safePage * PROJECT_PAGE_SIZE,
      (safePage + 1) * PROJECT_PAGE_SIZE
    );
    const keyboard = new InlineKeyboard()
      .text("➕ Nuovo progetto", "nt_create")
      .row();
    for (const name of pageSlice) {
      keyboard.text(name, `nt_project:${name}`).row();
    }
    if (safePage > 0) {
      keyboard.text("← Precedenti", `nt_projects:${safePage - 1}`);
    }
    if (safePage < totalPages - 1) {
      keyboard.text("Successivi →", `nt_projects:${safePage + 1}`);
    }
    if (totalPages > 1) {
      keyboard.row();
    }
    const pageIndicator =
      totalPages > 1 ? ` (${safePage + 1}/${totalPages})` : "";
    return {
      text: `Apri un argomento: scegli un progetto esistente${pageIndicator}, oppure crea un nuovo progetto con il pulsante qui sotto.`,
      keyboard,
    };
  }

  function providerKeyboard(projectName: string) {
    const keyboard = new InlineKeyboard();
    for (const provider of listProviders()) {
      keyboard
        .text(provider.displayName, `nt_provider:${projectName}:${provider.id}`)
        .row();
    }
    return keyboard;
  }

  async function createTopicAndAnnounce(
    ctx: Context,
    chatId: number,
    projectName: string,
    provider: ProviderId,
    customName?: string
  ) {
    const created = await createTopicSession({
      api: ctx.api,
      chatId,
      projectName,
      projectsDir,
      provider,
      customName,
    });
    // Pre-warm the in-memory state so the first message in the topic is fast.
    scopeStates.set(created.key, {
      activeProvider: created.record.activeProvider,
      activeProject: created.record.activeProject,
      models: {},
      efforts: {},
      queue: [],
      runKey: created.key,
      scopeKey: created.key,
      chatId,
      threadId: created.threadId,
    });
    return created;
  }

  const newProjectHelp = `Per creare un progetto e la sua cartella su Ubuntu, scrivi:\n/nuovo_progetto nome-progetto\n\nCartella di destinazione: ${projectsDir}\nPoi scegli Claude o Codex per aprire l'argomento. Per un progetto già presente usa /nuova.`;
  bot.callbackQuery("nt_create", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(newProjectHelp);
  });
  bot.command("nuovo_progetto", async (ctx) => {
    if (getScope(ctx).kind === "private") {
      await ctx.reply(
        "Per creare un progetto con il suo argomento, usa /nuovo_progetto nel gruppo Dev."
      );
      return;
    }
    const name = String(ctx.match ?? "").trim();
    if (!name) {
      await ctx.reply(newProjectHelp);
      return;
    }
    try {
      const path = createProjectFolder(projectsDir, name);
      await ctx.reply(
        `Progetto creato: ${name}\nCartella: ${path}\nScegli l'assistente per aprire il nuovo argomento:`,
        { reply_markup: providerKeyboard(name) }
      );
    } catch (error) {
      await ctx.reply(
        error instanceof Error
          ? error.message
          : "Creazione del progetto non riuscita."
      );
    }
  });

  bot.command("nuova", async (ctx) => {
    const scope = getScope(ctx);
    if (scope.kind === "private") {
      await ctx.reply(
        "Le sessioni per argomento vivono nel gruppo Dev: usa /nuova lì dentro."
      );
      return;
    }
    const args = (ctx.match ?? "").trim().split(WHITESPACE_RE).filter(Boolean);
    const projectName = args[0];
    const providerArg = args[1]?.toLowerCase();
    const customName = args.slice(2).join(" ") || undefined;
    if (!projectName) {
      const result = buildTopicProjectsMessage(0);
      if (!result) {
        await ctx.reply(`Nessun progetto in ${projectsDir}`);
        return;
      }
      await ctx.reply(result.text, { reply_markup: result.keyboard });
      return;
    }
    if (!listProjects(projectsDir).includes(projectName)) {
      await ctx.reply(
        `Progetto non trovato: ${projectName}. Usa /nuova senza argomenti per la lista.`
      );
      return;
    }
    if (providerArg !== "claude" && providerArg !== "codex") {
      await ctx.reply(`Assistente per ${projectLabel(projectName)}:`, {
        reply_markup: providerKeyboard(projectName),
      });
      return;
    }
    try {
      const created = await createTopicAndAnnounce(
        ctx,
        scope.chatId,
        projectName,
        providerArg,
        customName
      );
      await ctx.reply(`Creato l'argomento "${created.name}". Aprilo e scrivi.`);
    } catch (e) {
      await ctx.reply(
        `Non sono riuscito a creare l'argomento: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  });

  bot.callbackQuery(NT_PAGE_RE, async (ctx) => {
    const page = Number.parseInt(ctx.match?.[1] ?? "", 10);
    const result = buildTopicProjectsMessage(page);
    if (!result) {
      await ctx.answerCallbackQuery({ text: "Nessun progetto" });
      return;
    }
    await ctx.editMessageText(result.text, { reply_markup: result.keyboard });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(NT_PROJECT_RE, async (ctx) => {
    const projectName = ctx.match?.[1] ?? "";
    if (!listProjects(projectsDir).includes(projectName)) {
      await ctx.answerCallbackQuery({ text: "Progetto non trovato" });
      return;
    }
    await ctx.editMessageText(`Assistente per ${projectLabel(projectName)}:`, {
      reply_markup: providerKeyboard(projectName),
    });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(NT_PROVIDER_RE, async (ctx) => {
    const projectName = ctx.match?.[1] ?? "";
    const provider = ctx.match?.[2] as ProviderId;
    const scope = getScope(ctx);
    if (!listProjects(projectsDir).includes(projectName)) {
      await ctx.answerCallbackQuery({
        text: "Progetto non trovato. Riapri la lista con /nuova.",
      });
      return;
    }
    try {
      const created = await createTopicAndAnnounce(
        ctx,
        scope.chatId,
        projectName,
        provider
      );
      await ctx.answerCallbackQuery({ text: "Sessione creata" });
      await ctx.editMessageText(
        `Creato l'argomento "${created.name}". Aprilo e scrivi.`
      );
    } catch (e) {
      await ctx.answerCallbackQuery({ text: "Errore nella creazione" });
      await ctx.editMessageText(
        `Non sono riuscito a creare l'argomento: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  });

  bot.command("elenco", async (ctx) => {
    const scope = getScope(ctx);
    if (scope.kind === "private") {
      await ctx.reply("L'elenco delle sessioni si usa nel gruppo Dev.");
      return;
    }
    const topics = Object.entries(topicOps.list()).filter(
      ([, t]) => t.chatId === scope.chatId
    );
    if (topics.length === 0) {
      await ctx.reply("Nessuna sessione. Creane una con /nuova.");
      return;
    }
    const lines = topics.map(([key, t]) => {
      const running = hasActiveProcess(key) ? " · in esecuzione" : "";
      return `• ${escapeHtml(t.name)} — ${escapeHtml(basename(t.activeProject))} / ${escapeHtml(getProvider(t.activeProvider).displayName)}${running}`;
    });
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("chiudi", async (ctx) => {
    const scope = getScope(ctx);
    if (scope.kind !== "topic" || scope.threadId === undefined) {
      await ctx.reply("/chiudi si usa dentro un argomento del gruppo.");
      return;
    }
    const state = getState(scope);
    stopScope(state.runKey, "stopped");
    state.queue = [];
    state.pendingPlan = undefined;
    state.composeMessages = undefined;
    await runtime.runPromise(
      clearSession(
        sessionProjectKey(state.scopeKey, state.activeProject),
        state.activeProvider
      )
    );
    topicOps.remove(scope.key);
    scopeStates.delete(scope.key);
    await ctx.reply("Sessione archiviata. Chiudo l'argomento.");
    await ctx.api.closeForumTopic(scope.chatId, scope.threadId).catch(swallow);
  });

  bot.command("stop", async (ctx) => {
    const state = getState(getScope(ctx));
    const stopped = stopScope(state.runKey, "stopped");
    const hadQueue = state.queue.length > 0;
    state.queue = [];
    state.pendingPlan = undefined;
    state.composeMessages = undefined;
    await cleanupQueueStatus(state, ctx);
    await cleanupComposeStatus(state, ctx);
    const msg = stopped
      ? `Esecuzione interrotta.${hadQueue ? " Coda svuotata." : ""}`
      : "Nessuna esecuzione in corso.";
    await ctx.reply(msg, { reply_markup: removeReplyKeyboard });
  });

  bot.command("status", async (ctx) => {
    const state = getState(getScope(ctx));
    const project = describeProject(state.activeProject, projectsDir);
    const activeRun = getActiveRunSnapshot(state.runKey);
    let running = "No";
    if (hasActiveProcess(state.runKey)) {
      running = activeRun ? formatActiveRunTiming(activeRun) : "Sì";
    }
    const sessionCount = await runtime.runPromise(
      countSessions(state.activeProvider)
    );
    const branch =
      state.activeProject && state.activeProject !== projectsDir
        ? getCurrentBranch(state.activeProject)
        : null;
    const branchLine = branch ? `\nRamo Git: ${branch}` : "";
    const queueLine =
      state.queue.length > 0 ? `\nIn coda: ${state.queue.length}` : "";
    const composeLine = state.composeMessages
      ? `\nComposizione: ${state.composeMessages.length} messaggi`
      : "";
    const provider = state.activeProvider;
    const modelId = state.models[provider] ?? "default";
    const modelLabel =
      getModels(provider).find((m) => m.id === modelId)?.label ?? modelId;
    const effortId = state.efforts[provider] ?? getDefaultEffort(provider);
    const effortLabel =
      getEffortLevels(provider).find((e) => e.id === effortId)?.label ??
      effortId;
    const sessionWarning = await statusSessionWarning(state);

    await ctx.reply(
      `Assistente: ${activeProviderName(state)}\nModello: ${modelLabel} · Ragionamento: ${effortLabel}\nProgetto: ${project}\nIn esecuzione: ${running}\nSessioni: ${sessionCount}${branchLine}${queueLine}${composeLine}${sessionWarning}`,
      { reply_markup: removeReplyKeyboard }
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      [
        "<b>Comandi:</b>",
        "/menu — pulsanti per progetti, attività e impostazioni",
        "/nuova — apri un argomento dalla lista dei progetti",
        "/nuovo_progetto nome — crea cartella e prepara il nuovo argomento",
        "/projects — cambia progetto attivo",
        "/provider — scegli l’assistente di sviluppo",
        "/model — scegli il modello dell’assistente attivo",
        "/effort — scegli il livello di ragionamento dell’assistente attivo",
        "/history — riprendi una sessione precedente",
        "/new — inizia una nuova conversazione",
        "/stop — interrompi l’esecuzione in corso",
        "/diagnostica — verifica configurazione, assistenti e spazio disco",
        "/status — mostra lo stato attuale",
        "/branch — mostra il ramo Git attuale",
        "/pr — elenca le richieste di modifica aperte",
        "/compose — inizia a raccogliere messaggi",
        "/send — invia i messaggi raccolti",
        "/cancel — annulla la composizione",
        "/permessi — approvazioni per questa conversazione",
        "/stats — tempi, costi disponibili ed esiti",
        "/riepilogo — aggiorna il riepilogo fissato",
        "/programma — pianifica un lavoro",
        "/programmi — elenco lavori programmati",
        "/annulla_programma — annulla un programma",
        "/eventi — collega le notifiche dei servizi",
        "/help — mostra questo messaggio",
        "",
        "Invia un messaggio di testo o vocale per lavorare con l’assistente attivo sul progetto selezionato.",
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: removeReplyKeyboard }
    );
  });

  bot.command("branch", async (ctx) => {
    const state = getState(getScope(ctx));
    if (!state.activeProject || state.activeProject === projectsDir) {
      await ctx.reply(
        "Seleziona un progetto specifico: nessun progetto attivo oppure modalità Generale.",
        {
          reply_markup: removeReplyKeyboard,
        }
      );
      return;
    }

    const current = getCurrentBranch(state.activeProject);
    if (!current) {
      await ctx.reply("La cartella non è un repository Git.", {
        reply_markup: removeReplyKeyboard,
      });
      return;
    }

    const branches = listBranches(state.activeProject);
    const projectName = basename(state.activeProject);
    const others = (branches ?? []).filter((b) => b !== current);
    const visible = others.slice(0, 10);
    const collapsed = others.slice(10);
    const lines = [
      `<b>${escapeHtml(projectName)}</b>`,
      `Attuale: <code>${escapeHtml(current)}</code>`,
    ];
    if (visible.length > 0) {
      lines.push("", ...visible.map((b) => `<code>${escapeHtml(b)}</code>`));
    }
    if (collapsed.length > 0) {
      const collapsedLines = collapsed
        .map((b) => `<code>${escapeHtml(b)}</code>`)
        .join("\n");
      lines.push(`\n<blockquote expandable>${collapsedLines}</blockquote>`);
    }
    // listBranches caps at 50; if we got exactly 50 others, there are likely more
    if (others.length >= 49) {
      lines.push("<i>…sono mostrati soltanto i rami più recenti</i>");
    }
    await ctx.reply(lines.join("\n"), {
      parse_mode: "HTML",
      reply_markup: removeReplyKeyboard,
    });
  });

  bot.command("pr", async (ctx) => {
    const state = getState(getScope(ctx));
    if (!state.activeProject || state.activeProject === projectsDir) {
      await ctx.reply(
        "Seleziona un progetto specifico: nessun progetto attivo oppure modalità Generale.",
        {
          reply_markup: removeReplyKeyboard,
        }
      );
      return;
    }

    const prs = listOpenPRs(state.activeProject);
    if (prs === null) {
      await ctx.reply(
        "Impossibile recuperare le richieste di modifica. Verifica l’autenticazione della CLI gh.",
        {
          reply_markup: removeReplyKeyboard,
        }
      );
      return;
    }
    if (prs.length === 0) {
      await ctx.reply("Nessuna richiesta di modifica aperta.", {
        reply_markup: removeReplyKeyboard,
      });
      return;
    }

    const lines = prs.map(
      (pr) =>
        `#${pr.number} <a href="${escapeHtml(pr.url)}">${escapeHtml(pr.title)}</a> (<code>${escapeHtml(pr.headRefName)}</code>)`
    );
    await ctx.reply(lines.join("\n"), {
      parse_mode: "HTML",
      reply_markup: removeReplyKeyboard,
    });
  });

  bot.command("new", async (ctx) => {
    const state = getState(getScope(ctx));
    if (!state.activeProject) {
      setActiveProject(state, projectsDir);
    }
    // Interrupt any in-flight run first: otherwise its session_init/result tap
    // would re-persist the session id right after we clear it, so /new would
    // fail to start a fresh conversation.
    stopScope(state.runKey, "stopped");
    await runtime.runPromise(
      clearSession(
        sessionProjectKey(state.scopeKey, state.activeProject),
        state.activeProvider
      )
    );
    state.queue = [];
    state.pendingPlan = undefined;
    state.composeMessages = undefined;
    await cleanupQueueStatus(state, ctx);
    await cleanupComposeStatus(state, ctx);
    await ctx.reply(
      "Sessione azzerata. Il prossimo messaggio inizierà una nuova conversazione.",
      { reply_markup: removeReplyKeyboard }
    );
  });

  bot.command("compose", async (ctx) => {
    const state = getState(getScope(ctx));
    if (state.composeMessages) {
      await ctx.reply(
        `Composizione già attiva (${state.composeMessages.length} messaggi). Usa /send quando hai finito.`
      );
      return;
    }
    state.composeMessages = [];
    const keyboard = new InlineKeyboard()
      .text("Invia", `compose_send:${getUserId(ctx)}`)
      .text("Annulla", `compose_cancel:${getUserId(ctx)}`);
    const msg = await ctx.reply(
      "Composizione attiva. Invia i messaggi, poi usa /send quando hai finito.",
      { reply_markup: keyboard }
    );
    state.composeStatusMessageId = msg.message_id;
  });

  /** Execute send: combine composed messages and send to the active provider */
  async function executeSend(ctx: Context, state: UserState) {
    if (!state.composeMessages) {
      await ctx.reply("La composizione non è attiva.", {
        reply_markup: removeReplyKeyboard,
      });
      return;
    }
    if (state.composeMessages.length === 0) {
      state.composeMessages = undefined;
      await cleanupComposeStatus(state, ctx);
      await ctx.reply("Nessun messaggio da inviare. Composizione annullata.", {
        reply_markup: removeReplyKeyboard,
      });
      return;
    }
    const combined = state.composeMessages.map((m) => m.content).join("\n\n");
    state.composeMessages = undefined;
    await cleanupComposeStatus(state, ctx);
    handlePrompt(ctx, combined).catch((e) =>
      console.error("handlePrompt error:", e)
    );
  }

  /** Execute cancel: discard composed messages */
  async function executeCancel(ctx: Context, state: UserState) {
    if (!state.composeMessages) {
      await ctx.reply("La composizione non è attiva.", {
        reply_markup: removeReplyKeyboard,
      });
      return;
    }
    const count = state.composeMessages.length;
    state.composeMessages = undefined;
    await cleanupComposeStatus(state, ctx);
    await ctx.reply(`Composizione annullata. Messaggi scartati: ${count}.`, {
      reply_markup: removeReplyKeyboard,
    });
  }

  bot.command("send", async (ctx) => {
    const state = getState(getScope(ctx));
    await executeSend(ctx, state);
  });

  bot.command("cancel", async (ctx) => {
    const state = getState(getScope(ctx));
    await executeCancel(ctx, state);
  });

  bot.callbackQuery(COMPOSE_SEND_RE, async (ctx) => {
    const state = getState(getScope(ctx));
    await ctx.answerCallbackQuery();
    await executeSend(ctx, state);
  });

  bot.callbackQuery(COMPOSE_CANCEL_RE, async (ctx) => {
    const state = getState(getScope(ctx));
    await ctx.answerCallbackQuery();
    await executeCancel(ctx, state);
  });

  /** Format an ISO timestamp as a compact relative time (e.g. "5m ago", "Mar 3") */
  const formatRelativeTime = (isoTimestamp: string) => {
    const date = new Date(isoTimestamp);
    const diffMin = Math.floor((Date.now() - date.getTime()) / 60_000);
    if (diffMin < 1) {
      return "adesso";
    }
    if (diffMin < 60) {
      return `${diffMin} min fa`;
    }
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) {
      return `${diffHour} h fa`;
    }
    const diffDay = Math.floor(diffHour / 24);
    if (diffDay < 7) {
      return `${diffDay} giorni fa`;
    }
    return date.toLocaleDateString("it-IT", {
      month: "short",
      day: "numeric",
    });
  };

  /** Build paginated history message with inline keyboard */
  function buildHistoryMessage(page: number, providerId: ProviderId) {
    const sessions = listAllSessions(providerId);

    if (sessions.length === 0) {
      return null;
    }

    const totalPages = Math.ceil(sessions.length / HISTORY_PAGE_SIZE);
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const pageSlice = sessions.slice(
      safePage * HISTORY_PAGE_SIZE,
      (safePage + 1) * HISTORY_PAGE_SIZE
    );

    const keyboard = new InlineKeyboard();
    const blocks = pageSlice.map((s, i) => {
      const n = i + 1;
      keyboard.text(String(n), `session:${s.sessionId}`);
      const when = escapeHtml(formatRelativeTime(s.lastActiveAt));
      const project = escapeHtml(s.projectName);
      const topic = escapeHtml(s.summary.trim() || "(senza argomento)");
      return `<b>${n}.</b> ${when} · <i>${project}</i>\n${topic}`;
    });
    keyboard.row();

    const navRow: { text: string; data: string }[] = [];
    if (safePage > 0) {
      navRow.push({ text: "← Precedenti", data: `history:${safePage - 1}` });
    }
    if (safePage < totalPages - 1) {
      navRow.push({ text: "Successivi →", data: `history:${safePage + 1}` });
    }
    if (navRow.length > 0) {
      for (const btn of navRow) {
        keyboard.text(btn.text, btn.data);
      }
      keyboard.row();
    }

    const pageIndicator =
      totalPages > 1 ? ` (${safePage + 1}/${totalPages})` : "";
    const text = `<b>Sessioni${pageIndicator}</b>\n\n${blocks.join("\n\n")}`;
    return { text, keyboard };
  }

  bot.command("history", async (ctx) => {
    const state = getState(getScope(ctx));
    const result = buildHistoryMessage(0, state.activeProvider);

    if (!result) {
      await ctx.reply("Nessuna sessione precedente trovata.", {
        reply_markup: removeReplyKeyboard,
      });
      return;
    }

    await ctx.reply(result.text, {
      reply_markup: result.keyboard,
      parse_mode: "HTML",
    });
  });

  bot.callbackQuery(HISTORY_PAGE_RE, async (ctx) => {
    const page = Number.parseInt(ctx.match?.[1] ?? "", 10);
    const state = getState(getScope(ctx));
    const result = buildHistoryMessage(page, state.activeProvider);

    if (!result) {
      await ctx.answerCallbackQuery({ text: "Nessuna sessione trovata" });
      return;
    }

    await ctx.editMessageText(result.text, {
      reply_markup: result.keyboard,
      parse_mode: "HTML",
    });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(SESSION_CALLBACK_RE, async (ctx) => {
    const sessionId = ctx.match?.[1] ?? "";
    const state = getState(getScope(ctx));

    const cachedProject = getSessionProject(state.activeProvider, sessionId);
    if (cachedProject) {
      setActiveProject(state, cachedProject);
    }

    if (!state.activeProject) {
      await ctx.answerCallbackQuery({ text: "Nessun progetto selezionato" });
      return;
    }

    await runtime.runPromise(
      setSession({
        project: sessionProjectKey(state.scopeKey, state.activeProject),
        provider: state.activeProvider,
        sessionId,
      })
    );
    const chatId = requireChat(ctx);
    const projectName = basename(state.activeProject);
    await ctx.answerCallbackQuery({ text: "Sessione ripresa" });
    const msg = await ctx.editMessageText(
      `Sessione ripresa in <b>${escapeHtml(projectName)}</b>. Il prossimo messaggio continuerà questa conversazione.`,
      { parse_mode: "HTML" }
    );
    await repinMessage(ctx, chatId, msg);
  });

  bot.callbackQuery(FORCE_SEND_RE, async (ctx) => {
    const state = getState(getScope(ctx));
    const stopped = stopScope(state.runKey, "new_prompt");
    await ctx.answerCallbackQuery({
      text: stopped
        ? "Interruzione dell’attività in corso…"
        : "Nessuna esecuzione in corso",
    });
  });

  bot.callbackQuery(CLEAR_QUEUE_RE, async (ctx) => {
    const state = getState(getScope(ctx));
    const count = state.queue.length;
    state.queue = [];
    await cleanupQueueStatus(state, ctx);
    await ctx.answerCallbackQuery({
      text:
        count > 0
          ? `Messaggi rimossi dalla coda: ${count}.`
          : "La coda è vuota.",
    });
  });

  /** Read plan file and send to user with action buttons */
  async function presentPlan(
    ctx: Context,
    userId: number,
    state: UserState,
    result: { planPath?: string; sessionId?: string }
  ) {
    const planPath = result.planPath;
    if (!planPath) {
      await ctx.reply("Impossibile leggere il file del piano.", {
        reply_markup: removeReplyKeyboard,
      });
      return;
    }
    let planContent: string;
    try {
      planContent = readFileSync(planPath, "utf-8");
    } catch {
      await ctx.reply("Impossibile leggere il file del piano.", {
        reply_markup: removeReplyKeyboard,
      });
      return;
    }

    state.pendingPlan = {
      planPath,
      sessionId: result.sessionId,
      projectPath: state.activeProject,
    };

    const chatId = requireChat(ctx);
    const chunks = splitText(planContent);
    for (const chunk of chunks) {
      await sendRichMarkdown(ctx, chatId, chunk);
    }

    const keyboard = new InlineKeyboard()
      .text("Esegui (nuova sessione)", `plan_new:${userId}`)
      .row()
      .text("Esegui (mantieni il contesto)", `plan_resume:${userId}`)
      .row()
      .text("Modifica il piano", `plan_modify:${userId}`);

    await ctx.api.sendMessage(chatId, "Piano pronto. Come vuoi procedere?", {
      reply_markup: keyboard,
    });
  }

  bot.callbackQuery(PLAN_NEW_RE, async (ctx) => {
    const userId = ctx.from.id;
    const state = getState(getScope(ctx));
    const plan = activePendingPlan(state);
    if (!plan) {
      await ctx.answerCallbackQuery({ text: "Nessun piano in attesa" });
      return;
    }

    let planContent: string;
    try {
      planContent = readFileSync(plan.planPath, "utf-8");
    } catch {
      await ctx.answerCallbackQuery({
        text: "Impossibile leggere il file del piano",
      });
      state.pendingPlan = undefined;
      return;
    }

    setActiveProject(state, plan.projectPath);
    await runtime.runPromise(
      clearSession(
        sessionProjectKey(state.scopeKey, plan.projectPath),
        state.activeProvider
      )
    );
    state.pendingPlan = undefined;
    await ctx.answerCallbackQuery({
      text: "Esecuzione del piano (nuova sessione)…",
    });
    await ctx.editMessageText("Esecuzione del piano (nuova sessione)…");

    const prompt = `Execute the following plan. Do not re-enter plan mode.\n\n${planContent}`;
    runAndDrain(ctx, prompt, state, userId).catch((e) =>
      console.error("plan_new error:", e)
    );
  });

  bot.callbackQuery(PLAN_RESUME_RE, async (ctx) => {
    const userId = ctx.from.id;
    const state = getState(getScope(ctx));
    const plan = activePendingPlan(state);
    if (!plan) {
      await ctx.answerCallbackQuery({ text: "Nessun piano in attesa" });
      return;
    }

    setActiveProject(state, plan.projectPath);
    if (plan.sessionId) {
      await runtime.runPromise(
        setSession({
          project: sessionProjectKey(state.scopeKey, plan.projectPath),
          provider: state.activeProvider,
          sessionId: plan.sessionId,
        })
      );
    }
    state.pendingPlan = undefined;
    await ctx.answerCallbackQuery({
      text: "Esecuzione del piano (con il contesto attuale)…",
    });
    await ctx.editMessageText(
      "Esecuzione del piano (con il contesto attuale)…"
    );

    const prompt =
      "The plan has been approved. Proceed with execution. Do not re-enter plan mode.";
    runAndDrain(ctx, prompt, state, userId).catch((e) =>
      console.error("plan_resume error:", e)
    );
  });

  bot.callbackQuery(PLAN_MODIFY_RE, async (ctx) => {
    const userId = ctx.from.id;
    const state = getState(getScope(ctx));
    if (!activePendingPlan(state)) {
      await ctx.answerCallbackQuery({ text: "Nessun piano in attesa" });
      return;
    }
    const cancelKeyboard = new InlineKeyboard().text(
      "Annulla",
      `plan_cancel:${userId}`
    );
    await ctx.answerCallbackQuery({ text: "Invia le tue osservazioni" });
    await ctx.editMessageText(
      "Invia le tue osservazioni. Il prossimo messaggio continuerà la conversazione mantenendo il contesto del piano.",
      { reply_markup: cancelKeyboard }
    );
  });

  bot.callbackQuery(PLAN_CANCEL_RE, async (ctx) => {
    const userId = ctx.from.id;
    const state = getState(getScope(ctx));
    if (!activePendingPlan(state)) {
      await ctx.answerCallbackQuery({ text: "Nessun piano in attesa" });
      return;
    }
    const keyboard = new InlineKeyboard()
      .text("Esegui (nuova sessione)", `plan_new:${userId}`)
      .row()
      .text("Esegui (mantieni il contesto)", `plan_resume:${userId}`)
      .row()
      .text("Modifica il piano", `plan_modify:${userId}`);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Piano pronto. Come vuoi procedere?", {
      reply_markup: keyboard,
    });
  });

  /** Send a prompt to the active provider and stream the response */
  async function handlePrompt(ctx: Context, prompt: string) {
    const userId = getUserId(ctx);
    const state = getState(getScope(ctx));

    if (!state.activeProject) {
      setActiveProject(state, projectsDir);
      await ctx.reply(
        "Nessun progetto selezionato. Uso Generale (tutti i progetti).",
        {
          reply_markup: removeReplyKeyboard,
        }
      );
    }

    const pendingPlan = activePendingPlan(state);
    if (pendingPlan) {
      const plan = pendingPlan;
      setActiveProject(state, plan.projectPath);
      if (plan.sessionId) {
        await runtime.runPromise(
          setSession({
            project: sessionProjectKey(state.scopeKey, plan.projectPath),
            provider: state.activeProvider,
            sessionId: plan.sessionId,
          })
        );
      }
      state.pendingPlan = undefined;
      const feedbackPrompt = `Plan feedback from user: ${prompt}\n\nRevise the plan based on this feedback. Do not execute yet — present the updated plan.`;
      await runAndDrain(ctx, feedbackPrompt, state, userId);
      return;
    }

    if (busy(state.runKey)) {
      state.queue.push({ prompt, ctx });
      await sendOrUpdateQueueStatus(ctx, state);
      return;
    }

    await runAndDrain(ctx, prompt, state, userId);
  }

  /** Run one prompt to completion; returns true if a plan was presented (halts draining) */
  async function runSinglePrompt(
    ctx: Context,
    prompt: string,
    state: UserState,
    userId: number,
    automation?: { signal: AbortSignal; readOnly: boolean }
  ) {
    const provider = state.activeProvider;
    const project = state.activeProject;
    const providerSpec = getProvider(provider);
    const model = resolveModelChoice(providerSpec, state.models[provider]);
    const effort = resolveEffortChoice(providerSpec, state.efforts[provider]);
    const controller = new AbortController();
    scopeControllers.set(state.runKey, controller);
    const signal = automation
      ? AbortSignal.any([controller.signal, automation.signal])
      : controller.signal;
    const approvalPolicy = controls.store.getSettings(
      getScope(ctx).key
    ).approvalPolicy;
    if (provider === "codex" && approvalPolicy === "ask") {
      await ctx.reply(
        "Questa conversazione richiede approvazioni. Seleziona Claude con /provider oppure scegli esplicitamente /permessi automatici."
      );
      scopeControllers.delete(state.runKey);
      if (automation) {
        throw new Error("Codex non supporta le approvazioni Telegram.");
      }
      return false;
    }
    const sessionId = automation
      ? undefined
      : await runtime.runPromise(
          getSession(sessionProjectKey(state.scopeKey, project), provider)
        );
    const projectName = project === projectsDir ? "general" : basename(project);
    const branchName =
      project !== projectsDir ? getCurrentBranch(project) : null;

    const resumedSession = Boolean(sessionId);

    const startedAt = Date.now();
    await refreshSummary(
      ctx,
      automation ? "Automazione in esecuzione" : "In esecuzione"
    );
    let lastOutcome: RunRecord["outcome"] = "done";
    const outcome = await runWithAstraStartupFallback({
      provider,
      model,
      resumedSession,
      runIds: [crypto.randomUUID(), crypto.randomUUID()],
      executeAttempt: async (attempt) => {
        const meta: RunEventMeta = {
          runId: attempt.runId,
          userId,
          provider,
          project,
          promptChars: prompt.length,
          queueDepth: state.queue.length,
        };
        const rec: RunRecord = {
          outcome: "done",
          costUsd: null,
          turns: null,
          totalTokens: null,
          durationMs: null,
          sessionId: attempt.fallbackAttempted ? null : (sessionId ?? null),
        };
        let result: StreamResult = { observableWorkStarted: false };
        let presentedPlan = false;
        const attemptStartedAt = Date.now();
        const abort = () => {
          controls.approvals.cancelRun(meta.runId);
          if (getActiveRunSnapshot(state.runKey)?.runId === meta.runId) {
            stopAgent(state.runKey, "stopped");
          }
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
          if (signal.aborted) {
            throw new Error("Esecuzione annullata.");
          }
          await emitLifecycleEvent(
            new RunStartedEvent({
              ts: new Date().toISOString(),
              event: RUN_STARTED_MARKER,
              runId: meta.runId,
              userId,
              provider,
              project: projectName,
              model: attempt.model,
              effort,
              queueDepth: state.queue.length,
              version: BOT_VERSION,
              host: hostname(),
            })
          );
          const events = runAgent(provider, {
            userId,
            runKey: state.runKey,
            sessionKey: sessionProjectKey(state.scopeKey, project),
            prompt,
            projectDir: project,
            chatId: requireChat(ctx),
            threadId: state.threadId,
            approvalPolicy,
            readOnly: automation?.readOnly,
            persistSession: !automation,
            signal,
            requestApproval: (request) =>
              controls.approvals.request(
                {
                  userId,
                  chatId: requireChat(ctx),
                  threadId: state.threadId,
                  runId: meta.runId,
                  runKey: state.runKey,
                },
                request,
                async (approval) => {
                  await ctx.reply(approval.text, {
                    parse_mode: "HTML",
                    reply_markup: approval.replyMarkup,
                  });
                }
              ),
            runId: meta.runId,
            sessionId: attempt.fallbackAttempted ? undefined : sessionId,
            model: attempt.model,
            effort,
          });
          result = await streamToTelegram(
            ctx,
            events,
            projectName,
            getCapabilities(provider),
            {
              branchName,
              inactivityWarningMs,
              onProgress: (at) =>
                noteAgentProgress(state.runKey, meta.runId, at),
            }
          );
          if (result.sessionId) {
            // Persisted by the runner's stream tap (session_init + result); here
            // it is copied only to the matching attempt's wide event.
            rec.sessionId = result.sessionId;
          }
          applyResultEconomics(result, rec);

          if (result.planPath && getCapabilities(provider).planMode) {
            stopAgent(state.runKey, "stopped");
            if (automation) {
              await ctx.reply(
                "L'automazione ha prodotto un piano e si è fermata senza eseguirlo. Riprendi il lavoro con un messaggio in questo argomento."
              );
            } else {
              await presentPlan(ctx, userId, state, result);
            }
            presentedPlan = true;
          }
        } catch (e) {
          rec.outcome = "errored";
          rec.errorClass =
            (e as { _tag?: string })?._tag ??
            (e as Error)?.name ??
            "ProviderCrashed";
          rec.errorMessage = clipError(String((e as Error)?.message ?? e));
          console.error("runAndDrain error:", e);
        } finally {
          signal.removeEventListener("abort", abort);
          controls.approvals.cancelRun(meta.runId);
          if (signal.aborted) {
            rec.outcome = "interrupted";
          }
          lastOutcome = rec.outcome;
          await emitRunEvent(rec, meta);
          if (rec.outcome !== "already_running") {
            try {
              controls.store.recordRun({
                scopeKey: getScope(ctx).key,
                project,
                provider,
                runId: meta.runId,
                startedAt: new Date(attemptStartedAt).toISOString(),
                durationMs: rec.durationMs ?? Date.now() - attemptStartedAt,
                costUsd: rec.costUsd,
                totalTokens: rec.totalTokens,
                outcome: rec.outcome,
              });
            } catch {
              console.warn(
                "Statistiche non salvate: archivio operazioni da verificare."
              );
            }
          }
        }
        return { ...result, presentedPlan };
      },
      beforeFallback: async (failed) => {
        // `resumedSession` is false by classifier contract, so this can only
        // clear the newly created failed Codex session for this project.
        if (failed.sessionId && !automation) {
          const cleared = await runtime.runPromise(
            clearSessionIfMatches(
              sessionProjectKey(state.scopeKey, project),
              "codex",
              failed.sessionId
            )
          );
          if (!cleared) {
            await ctx.reply(
              "Fallback non avviato: la sessione Codex è cambiata mentre Astra terminava. La nuova sessione è stata conservata."
            );
            return false;
          }
        }
        await ctx.reply(
          "Astra non disponibile prima dell'avvio: riprovo una volta con Sol. Nessun lavoro è stato ripetuto."
        );
        return true;
      },
    });

    if (scopeControllers.get(state.runKey) === controller) {
      scopeControllers.delete(state.runKey);
    }
    const outcomeLabel: Record<RunRecord["outcome"], string> = {
      done: "completata",
      errored: "errore",
      interrupted: "interrotta",
      timeout: "tempo scaduto",
      already_running: "già in corso",
      at_capacity: "limite di esecuzioni raggiunto",
    };
    await refreshSummary(
      ctx,
      outcome.presentedPlan
        ? "Piano in attesa"
        : `Esecuzione terminata (${outcomeLabel[lastOutcome]})`
    );
    if (state.threadId !== undefined && Date.now() - startedAt >= 120_000) {
      let label = "esecuzione terminata";
      if (lastOutcome !== "done") {
        label = `esecuzione terminata: ${outcomeLabel[lastOutcome]}`;
      }
      if (outcome.presentedPlan) {
        label = "piano in attesa";
      }
      await bot.api
        .sendMessage(
          requireChat(ctx),
          `${projectName}: ${label}. Risultato nell'argomento ${state.threadId}.`,
          { message_thread_id: 1 }
        )
        .catch(swallow);
    }
    if (
      automation &&
      (lastOutcome !== "done" ||
        outcome.presentedPlan ||
        automation.signal.aborted)
    ) {
      throw new Error("Automazione non conclusa regolarmente.");
    }
    return outcome.presentedPlan;
  }

  /** Notify the user that a queued message is now being processed */
  async function notifyQueuedProcessing(
    ctx: Context,
    prompt: string,
    state: UserState
  ) {
    const remaining = state.queue.length;
    const queueInfo = remaining > 0 ? ` | altri ${remaining} in coda` : "";
    const preview = prompt.length > 200 ? `${prompt.slice(0, 200)}...` : prompt;
    await ctx
      .reply(
        `<b>▶ Elaborazione del messaggio in coda</b>${queueInfo}\n<pre>${escapeHtml(preview)}</pre>`,
        { parse_mode: "HTML" }
      )
      .catch(swallow);
  }

  /** Run an agent prompt and drain any queued messages afterward */
  async function runAndDrain(
    ctx: Context,
    prompt: string,
    state: UserState,
    userId: number
  ) {
    if (closing) {
      return;
    }
    if (reservedRuns.has(state.runKey)) {
      state.queue.push({ prompt, ctx });
      await sendOrUpdateQueueStatus(ctx, state);
      return;
    }
    reservedRuns.add(state.runKey);
    try {
      let currentCtx = ctx;
      let currentPrompt = prompt;
      while (!closing) {
        const presentedPlan = await runSinglePrompt(
          currentCtx,
          currentPrompt,
          state,
          userId
        );
        if (presentedPlan) {
          return;
        }
        const next = state.queue.shift();
        if (!next) {
          break;
        }
        currentPrompt = next.prompt;
        currentCtx = next.ctx;
        if (state.queue.length === 0) {
          await cleanupQueueStatus(state, currentCtx);
        }
        await notifyQueuedProcessing(currentCtx, currentPrompt, state);
      }
    } finally {
      reservedRuns.delete(state.runKey);
      scopeControllers.delete(state.runKey);
      if (state.queue.length === 0) {
        await cleanupQueueStatus(state, ctx);
      }
    }
  }

  /** Send or update the "Message queued" status message with Force Send button */
  async function sendOrUpdateQueueStatus(ctx: Context, state: UserState) {
    const text = `Messaggio aggiunto alla coda (totale: ${state.queue.length})`;
    const keyboard = new InlineKeyboard()
      .text(
        "Invia subito — interrompe l’attività in corso",
        `force_send:${ctx.from?.id}`
      )
      .row()
      .text("Svuota la coda", `clear_queue:${ctx.from?.id}`);
    if (state.queueStatusMessageId) {
      await ctx.api
        .editMessageText(requireChat(ctx), state.queueStatusMessageId, text, {
          reply_markup: keyboard,
        })
        .catch(swallow);
    } else {
      const msg = await ctx.reply(text, { reply_markup: keyboard });
      state.queueStatusMessageId = msg.message_id;
    }
  }

  /** Delete the queue status message if it exists */
  async function cleanupQueueStatus(state: UserState, ctx: Context) {
    if (state.queueStatusMessageId) {
      await ctx.api
        .deleteMessage(requireChat(ctx), state.queueStatusMessageId)
        .catch(swallow);
      state.queueStatusMessageId = undefined;
    }
  }

  /** Send or update compose mode status message with inline buttons */
  async function updateComposeStatus(ctx: Context, state: UserState) {
    const count = state.composeMessages?.length ?? 0;
    const text = `Composizione (${count} ${count === 1 ? "messaggio" : "messaggi"})`;
    const keyboard = new InlineKeyboard()
      .text("Invia", `compose_send:${ctx.from?.id}`)
      .text("Annulla", `compose_cancel:${ctx.from?.id}`);
    if (state.composeStatusMessageId) {
      await ctx.api
        .editMessageText(requireChat(ctx), state.composeStatusMessageId, text, {
          reply_markup: keyboard,
        })
        .catch(swallow);
    } else {
      const msg = await ctx.reply(text, { reply_markup: keyboard });
      state.composeStatusMessageId = msg.message_id;
    }
  }

  /** Delete the compose status message if it exists */
  async function cleanupComposeStatus(state: UserState, ctx: Context) {
    if (state.composeStatusMessageId) {
      await ctx.api
        .deleteMessage(requireChat(ctx), state.composeStatusMessageId)
        .catch(swallow);
      state.composeStatusMessageId = undefined;
    }
  }

  /** Transcribe a voice message and show the transcription as a status reply */
  async function transcribeVoiceForCompose(ctx: Context, messageId: number) {
    const file = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const res = await fetch(url);
    const buffer = Buffer.from(await res.arrayBuffer());
    const status = await ctx.reply("Trascrizione in corso…", {
      reply_parameters: { message_id: messageId },
    });
    const transcription = await transcribeAudio(buffer, "voice.ogg");
    const maxDisplay = 3800;
    const displayText =
      transcription.length > maxDisplay
        ? `${transcription.slice(0, maxDisplay)}... (testo abbreviato)`
        : transcription;
    await ctx.api.editMessageText(
      requireChat(ctx),
      status.message_id,
      `<blockquote>${escapeHtml(displayText)}</blockquote>`,
      { parse_mode: "HTML" }
    );
    return transcription;
  }

  /** Build a ComposeMessage from the incoming message, or undefined if unsupported */
  async function buildComposeMessage(
    ctx: Context
  ): Promise<ComposeMessage | undefined> {
    const message = ctx.message;
    if (!message) {
      return;
    }
    if (message.voice) {
      const content = await transcribeVoiceForCompose(ctx, message.message_id);
      return { type: "voice", content };
    }
    if (message.document) {
      const filename = message.document.file_name ?? `file_${Date.now()}`;
      const dest = await saveUploadedFile(ctx, filename);
      const caption = message.caption ?? "";
      return {
        type: "file",
        content: `[File: ${filename} saved at ${dest}]\n${caption}`.trim(),
      };
    }
    if (message.photo) {
      const largest = message.photo.at(-1);
      if (!largest) {
        return;
      }
      const filename = `photo_${Date.now()}.jpg`;
      const dest = await saveUploadedFile(ctx, filename, largest.file_id);
      const caption = message.caption ?? "";
      return {
        type: "photo",
        content: `[Photo saved at ${dest}]\n${caption}`.trim(),
      };
    }
    if (message.forward_origin) {
      const text = message.text ?? message.caption ?? "";
      return {
        type: "forwarded",
        content: `[Forwarded from ${forwardSenderName(message.forward_origin)}]\n${text}`,
      };
    }
    if (message.text) {
      return { type: "text", content: message.text };
    }
    return;
  }

  /** Collect a message into compose queue based on its type */
  async function collectComposeMessage(ctx: Context, state: UserState) {
    const messages = state.composeMessages;
    if (!messages) {
      return;
    }
    if (messages.length >= MAX_COMPOSE_MESSAGES) {
      await ctx.reply(
        `Limite di composizione raggiunto (${MAX_COMPOSE_MESSAGES} messaggi). Usa /send per inviarli o /stop per eliminarli.`
      );
      return;
    }
    try {
      const message = await buildComposeMessage(ctx);
      if (message) {
        messages.push(message);
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : "errore sconosciuto";
      await ctx
        .reply(`Errore durante la raccolta del messaggio: ${errMsg}`)
        .catch(swallow);
      return;
    }
    await updateComposeStatus(ctx, state);
  }

  bot.on("message:text", (ctx) => {
    const prompt = buildPromptWithReplyContext(ctx, ctx.message.text, botId);
    handlePrompt(ctx, prompt).catch((e) =>
      console.error("handlePrompt error:", e)
    );
  });

  bot.on("message:voice", async (ctx) => {
    const state = getState(getScope(ctx));

    if (!state.activeProject) {
      setActiveProject(state, projectsDir);
      await ctx.reply(
        "Nessun progetto selezionato. Uso Generale (tutti i progetti).",
        {
          reply_markup: removeReplyKeyboard,
        }
      );
    }

    let prompt: string;
    try {
      const path = await saveUploadedFile(
        ctx,
        `voice_${ctx.message.message_id}.ogg`
      );
      const buffer = readFileSync(path);

      const status = await ctx.reply("Trascrizione in corso…", {
        reply_parameters: { message_id: ctx.message.message_id },
      });
      prompt = await transcribeAudio(buffer, "voice.ogg");
      const maxDisplay = 3800;
      const displayText =
        prompt.length > maxDisplay
          ? `${prompt.slice(0, maxDisplay)}... (testo abbreviato)`
          : prompt;
      await ctx.api.editMessageText(
        ctx.chat.id,
        status.message_id,
        `<blockquote>${escapeHtml(displayText)}</blockquote>`,
        { parse_mode: "HTML" }
      );
    } catch (e) {
      console.error("Voice transcription error:", e);
      await ctx.reply(
        `Trascrizione non riuscita: ${e instanceof Error ? e.message : "errore sconosciuto"}`
      );
      return;
    }

    const fullPrompt = buildPromptWithReplyContext(ctx, prompt, botId);
    handlePrompt(ctx, fullPrompt).catch((e) =>
      console.error("handlePrompt error:", e)
    );
  });

  /** Download a Telegram file and save to project's user-sent-files dir */
  async function saveUploadedFile(
    ctx: Context,
    filename: string,
    fileId?: string
  ) {
    const state = getState(getScope(ctx));
    if (!state.activeProject) {
      setActiveProject(state, projectsDir);
      await ctx.reply(
        "Nessun progetto selezionato. Uso Generale (tutti i progetti).",
        {
          reply_markup: removeReplyKeyboard,
        }
      );
    }

    const download = async () => {
      const file = fileId ? await ctx.api.getFile(fileId) : await ctx.getFile();
      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) {
        throw new Error("download");
      }
      return { file, buffer: Buffer.from(await res.arrayBuffer()) };
    };
    const { file, buffer } = await download().catch(() => {
      throw new Error("Download Telegram non riuscito. Riprova l'allegato.");
    });
    const document = ctx.message?.document;
    const stored = await storeAttachment({
      rootDir:
        process.env.ATTACHMENTS_DIR?.trim() ||
        process.env.UPLOADS_DIR?.trim() ||
        join(import.meta.dirname, "..", ".data", "attachments"),
      projectPath: state.activeProject,
      scopeKey: getScope(ctx).key,
      originalName: filename,
      mimeType:
        document?.mime_type ??
        ctx.message?.voice?.mime_type ??
        (ctx.message?.photo ? "image/jpeg" : "application/octet-stream"),
      telegramFileId: file.file_id,
      telegramFileUniqueId: file.file_unique_id,
      data: buffer,
    });
    return stored.path;
  }

  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    const filename = doc.file_name ?? `file_${Date.now()}`;

    try {
      const dest = await saveUploadedFile(ctx, filename);
      if (!dest) {
        return;
      }

      const caption = ctx.message.caption ?? "See the attached file.";
      const prompt = `${caption}\n\n[File: ${filename} saved at ${dest}]`;
      const fullPrompt = buildPromptWithReplyContext(ctx, prompt, botId);
      handlePrompt(ctx, fullPrompt).catch((e) =>
        console.error("handlePrompt error:", e)
      );
    } catch (e) {
      console.error("Document upload error:", e);
      await ctx.reply(
        `Caricamento del file non riuscito: ${e instanceof Error ? e.message : "errore sconosciuto"}`
      );
    }
  });

  /** Flush a completed media group: save all photos and send as one prompt */
  async function flushMediaGroup(groupId: string) {
    const group = mediaGroupBuffers.get(groupId);
    mediaGroupBuffers.delete(groupId);
    if (!group) {
      return;
    }

    const { ctx, photos, caption } = group;
    const state = getState(getScope(ctx));

    try {
      const photoParts: string[] = [];
      for (const photo of photos) {
        const dest = await saveUploadedFile(ctx, photo.filename, photo.fileId);
        photoParts.push(`[Photo saved at ${dest}]`);
      }
      const text = caption || "See the attached photos.";
      const prompt = `${text}\n\n${photoParts.join("\n")}`;

      if (state.composeMessages) {
        for (const part of photoParts) {
          state.composeMessages.push({
            type: "photo",
            content: `${part}\n${caption}`.trim(),
          });
        }
        await updateComposeStatus(ctx, state);
      } else {
        const fullPrompt = buildPromptWithReplyContext(ctx, prompt, botId);
        handlePrompt(ctx, fullPrompt).catch((e) =>
          console.error("handlePrompt error:", e)
        );
      }
    } catch (e) {
      console.error("Media group upload error:", e);
      await ctx.reply(
        `Caricamento della foto non riuscito: ${e instanceof Error ? e.message : "errore sconosciuto"}`
      );
    }
  }

  bot.on("message:photo", async (ctx) => {
    const largest = ctx.message.photo.at(-1);
    if (!largest) {
      return;
    }
    const filename = `photo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.jpg`;
    const mediaGroupId = ctx.message.media_group_id;

    if (mediaGroupId) {
      const existing = mediaGroupBuffers.get(mediaGroupId);
      if (existing) {
        clearTimeout(existing.timer);
        existing.photos.push({ fileId: largest.file_id, filename });
        if (ctx.message.caption) {
          existing.caption = ctx.message.caption;
        }
        existing.timer = setTimeout(
          () => flushMediaGroup(mediaGroupId),
          MEDIA_GROUP_DEBOUNCE_MS
        );
      } else {
        const timer = setTimeout(
          () => flushMediaGroup(mediaGroupId),
          MEDIA_GROUP_DEBOUNCE_MS
        );
        mediaGroupBuffers.set(mediaGroupId, {
          photos: [{ fileId: largest.file_id, filename }],
          caption: ctx.message.caption ?? "",
          ctx,
          timer,
        });
      }
      return;
    }

    // Single photo (no media group)
    try {
      const dest = await saveUploadedFile(ctx, filename, largest.file_id);
      if (!dest) {
        return;
      }

      const caption = ctx.message.caption ?? "See the attached photo.";
      const prompt = `${caption}\n\n[Photo saved at ${dest}]`;
      const fullPrompt = buildPromptWithReplyContext(ctx, prompt, botId);
      handlePrompt(ctx, fullPrompt).catch((e) =>
        console.error("handlePrompt error:", e)
      );
    } catch (e) {
      console.error("Photo upload error:", e);
      await ctx.reply(
        `Caricamento della foto non riuscito: ${e instanceof Error ? e.message : "errore sconosciuto"}`
      );
    }
  });

  return bot;
}
