import {
  type Bot,
  type Context,
  InlineKeyboard,
  type Transformer,
} from "grammy";
import type { ScopeKind } from "./scope";

const PAGE_SIZE = 10;
const MENU_CALLBACK = /^menu:/;
const PAGE_CALLBACK = /^menu:(topics|active):(\d+)$/;
const GROUP_COMMANDS = new Set(["nuova", "nuovo_progetto", "help"]);
const SESSION_COMMANDS = new Set([
  "provider",
  "model",
  "effort",
  "permessi",
  "stats",
  "status",
  "history",
  "compose",
  "send",
  "cancel",
  "new",
  "stop",
  "projects",
  "programmi",
]);
const SETTINGS_CALLBACK = /^(provider|model|effort|nt_|hist)/;

export interface MenuContext {
  approvalPolicy?: "automatic" | "ask";
  effort?: string;
  kind: ScopeKind;
  model?: string;
  project?: string;
  provider?: string;
  queued?: number;
  running?: boolean;
}
export interface MenuTopic {
  chatId: number;
  name: string;
  running: boolean;
  threadId: number;
}
interface MenuView {
  keyboard: InlineKeyboard;
  text: string;
}

export function menuActionCommand(
  kind: ScopeKind,
  command: string
): string | undefined {
  if (kind === "denied") {
    return undefined;
  }
  if (GROUP_COMMANDS.has(command)) {
    return command;
  }
  return kind !== "control" && SESSION_COMMANDS.has(command)
    ? command
    : undefined;
}
export function topicLink(
  chatId: number,
  threadId: number
): string | undefined {
  const id = String(chatId);
  if (
    !(Number.isSafeInteger(chatId) && id.startsWith("-100")) ||
    id.length <= 4 ||
    !Number.isSafeInteger(threadId) ||
    threadId < 1
  ) {
    return undefined;
  }
  return `https://t.me/c/${id.slice(4)}/${threadId}`;
}
export function buildDevMenu(context: MenuContext): MenuView {
  const keyboard = new InlineKeyboard();
  if (context.kind === "control") {
    keyboard
      .text("📂 Progetti e argomenti", "menu:topics:0")
      .row()
      .text("➕ Apri argomento", "menu:run:nuova")
      .text("🆕 Nuovo progetto", "menu:run:nuovo_progetto")
      .row()
      .text("▶ Attività in corso", "menu:active:0")
      .text("🔄 Aggiorna", "menu:home")
      .row()
      .text("📌 Fissa menu", "menu:pin");
    return {
      text: "DEV · Menu\n\nApri un argomento per lavorare sul suo progetto. Puoi tenere più lavori attivi in argomenti diversi.",
      keyboard,
    };
  }
  keyboard
    .text("⚙️ Impostazioni", "menu:settings")
    .text("📊 Statistiche", "menu:run:stats")
    .row()
    .text("📚 Cronologia", "menu:run:history")
    .text("🆕 Nuova conversazione", "menu:run:new")
    .row()
    .text("📝 Raccogli messaggi", "menu:run:compose")
    .text("📤 Invia raccolta", "menu:run:send")
    .row()
    .text("⏹ Ferma lavoro", "menu:run:stop")
    .text("🔄 Aggiorna", "menu:home")
    .row();
  if (context.kind === "topic") {
    keyboard
      .text("📂 Altri progetti", "menu:topics:0")
      .text("▶ Attività", "menu:active:0");
  } else {
    keyboard.text("📂 Cambia progetto", "menu:run:projects");
  }
  const text = [
    `DEV · ${context.project ?? "Sessione"}`,
    `${context.provider ?? "Assistente"} · ${context.model ?? "predefinito"}`,
    `Ragionamento: ${context.effort ?? "predefinito"}`,
    `Stato: ${context.running ? "in esecuzione" : "libero"} · messaggi in coda: ${context.queued ?? 0}`,
    "",
    "I pulsanti agiscono su questa conversazione.",
  ].join("\n");
  return { text, keyboard };
}
export function buildTopicNavigation(
  chatId: number,
  topics: MenuTopic[],
  page: number,
  activeOnly: boolean
): MenuView {
  const selected = topics
    .filter((t) => t.chatId === chatId && (!activeOnly || t.running))
    .sort((a, b) => a.name.localeCompare(b.name, "it"));
  const pages = Math.max(1, Math.ceil(selected.length / PAGE_SIZE));
  const current = Math.max(
    0,
    Math.min(Number.isSafeInteger(page) ? page : 0, pages - 1)
  );
  const keyboard = new InlineKeyboard();
  for (const topic of selected.slice(
    current * PAGE_SIZE,
    (current + 1) * PAGE_SIZE
  )) {
    const link = topicLink(chatId, topic.threadId);
    if (link) {
      keyboard
        .url(`${topic.running ? "▶" : "•"} ${topic.name.slice(0, 55)}`, link)
        .row();
    }
  }
  const prefix = activeOnly ? "active" : "topics";
  if (current > 0) {
    keyboard.text("← Precedenti", `menu:${prefix}:${current - 1}`);
  }
  if (current < pages - 1) {
    keyboard.text("Successivi →", `menu:${prefix}:${current + 1}`);
  }
  keyboard
    .row()
    .text("➕ Apri argomento", "menu:run:nuova")
    .row()
    .text("↩ Menu", "menu:home");
  const title = activeOnly ? "Attività in corso" : "Progetti e argomenti";
  return {
    text: `${title} · ${selected.length}\n${selected.length ? `Tocca un nome per entrare nell'argomento. Pagina ${current + 1}/${pages}.` : "Nessun argomento da mostrare."}`,
    keyboard,
  };
}
export const menuShortcut = () =>
  new InlineKeyboard().text("☰ Menu", "menu:open");

/** Replace the private reply keyboard in groups; keep shortcuts on settings screens. */
export const menuReplyTransformer: Transformer = (
  previous,
  method,
  payload,
  signal
) => {
  if (
    (method !== "sendMessage" && method !== "editMessageText") ||
    !("chat_id" in payload) ||
    Number(payload.chat_id) >= 0 ||
    !("reply_markup" in payload)
  ) {
    return previous(method, payload, signal);
  }
  const markup = payload.reply_markup;
  if (markup && "keyboard" in markup) {
    return previous(
      method,
      { ...payload, reply_markup: menuShortcut() },
      signal
    );
  }
  if (markup && "inline_keyboard" in markup) {
    const callbacks = markup.inline_keyboard
      .flat()
      .flatMap((button) =>
        "callback_data" in button ? [button.callback_data] : []
      );
    if (
      callbacks.some((data) => SETTINGS_CALLBACK.test(data)) &&
      !callbacks.some((data) => data.startsWith("menu:"))
    ) {
      return previous(
        method,
        {
          ...payload,
          reply_markup: {
            inline_keyboard: [
              ...markup.inline_keyboard,
              [{ text: "↩ Menu", callback_data: "menu:open" }],
            ],
          },
        },
        signal
      );
    }
  }
  return previous(method, payload, signal);
};

function buildMenuSubpage(
  context: MenuContext,
  data: string
): MenuView | undefined {
  if (context.kind === "control" || context.kind === "denied") {
    return undefined;
  }
  if (data === "menu:settings") {
    return {
      text: `Impostazioni · ${context.project ?? "questa conversazione"}\nScegli cosa cambiare. Il cambio assistente interrompe il lavoro attivo.`,
      keyboard: new InlineKeyboard()
        .text("Assistente", "menu:run:provider")
        .text("Modello", "menu:run:model")
        .row()
        .text("Ragionamento", "menu:run:effort")
        .text("Permessi", "menu:permissions")
        .row()
        .text("↩ Menu", "menu:home"),
    };
  }
  if (data === "menu:permissions") {
    const ask = context.approvalPolicy === "ask";
    return {
      text: `Permessi attuali: ${ask ? "chiedi" : "automatici"}\nChiedi: con Claude approvi ogni strumento; Codex resta bloccato.\nAutomatici: esecuzione senza richieste Telegram.`,
      keyboard: new InlineKeyboard()
        .text(`${ask ? "✓ " : ""}Chiedi`, "menu:permission:ask")
        .text(`${ask ? "" : "✓ "}Automatici`, "menu:permission:auto")
        .row()
        .text("↩ Impostazioni", "menu:settings"),
    };
  }
  return undefined;
}
function commandForCallback(kind: ScopeKind, data: string): string | undefined {
  if (kind !== "control" && kind !== "denied") {
    if (data === "menu:permission:ask") {
      return "permessi chiedi";
    }
    if (data === "menu:permission:auto") {
      return "permessi automatici";
    }
  }
  return data.startsWith("menu:run:")
    ? menuActionCommand(kind, data.slice(9))
    : undefined;
}

async function pinMenu(ctx: Context) {
  const message = ctx.callbackQuery?.message;
  if (!(message?.date && ctx.chat)) {
    return;
  }
  try {
    await ctx.api.pinChatMessage(ctx.chat.id, message.message_id, {
      disable_notification: true,
    });
    await ctx.reply(
      "Menu fissato in Generale. Puoi riaprirlo anche con /menu."
    );
  } catch {
    await ctx.reply(
      "Non riesco a fissare il menu. Verifica che il bot abbia il permesso di fissare messaggi."
    );
  }
}

export function installDevMenu(options: {
  bot: Bot;
  context(ctx: Context): MenuContext;
  topics(): MenuTopic[];
  runCommand(ctx: Context, command: string): Promise<void>;
}) {
  const render = async (ctx: Context, view: MenuView, fresh = false) => {
    if (ctx.callbackQuery && !fresh) {
      try {
        await ctx.editMessageText(view.text, { reply_markup: view.keyboard });
      } catch (error) {
        if (
          !(error as { description?: string }).description?.includes(
            "message is not modified"
          )
        ) {
          throw error;
        }
      }
    } else {
      await ctx.reply(view.text, { reply_markup: view.keyboard });
    }
  };
  const show = (ctx: Context, fresh = false) =>
    render(ctx, buildDevMenu(options.context(ctx)), fresh);
  options.bot.command("menu", (ctx) => show(ctx));
  options.bot.callbackQuery(MENU_CALLBACK, async (ctx) => {
    const data = ctx.callbackQuery.data;
    const context = options.context(ctx);
    if (context.kind === "denied") {
      await ctx.answerCallbackQuery();
      return;
    }
    await ctx.answerCallbackQuery();
    if (data === "menu:home" || data === "menu:open") {
      await show(ctx, data === "menu:open");
      return;
    }
    const page = PAGE_CALLBACK.exec(data);
    if (page && ctx.chat && context.kind !== "private") {
      await render(
        ctx,
        buildTopicNavigation(
          ctx.chat.id,
          options.topics(),
          Number(page[2]),
          page[1] === "active"
        )
      );
      return;
    }
    const subpage = buildMenuSubpage(context, data);
    if (subpage) {
      await render(ctx, subpage);
      return;
    }
    if (data === "menu:pin" && context.kind === "control") {
      await pinMenu(ctx);
      return;
    }
    const command = commandForCallback(context.kind, data);
    if (command) {
      await options.runCommand(ctx, command);
      return;
    }
    await ctx.reply(
      "Questo comando non è disponibile qui. Apri un argomento e usa /menu.",
      { reply_markup: menuShortcut() }
    );
  });
  return { show };
}
