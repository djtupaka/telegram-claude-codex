import { randomBytes } from "node:crypto";
import { type Context, InlineKeyboard } from "grammy";
import type { ProviderId } from "./agent/types";
import { createProjectFolder, validateProjectName } from "./project-folders";

const NAME_PROMPT = "Nuovo progetto · Nome\n";

interface PendingProject {
  expires: number;
  name?: string;
  nonce: string;
  promptId?: number;
}
interface WizardOptions {
  createTopic: (
    ctx: Context,
    chatId: number,
    name: string,
    provider: ProviderId
  ) => Promise<{ name: string }>;
  now?: () => number;
  projectsDir: string;
}

/** Ephemeral, scoped replies: unrelated topic messages remain normal prompts. */
export function createProjectWizard(options: WizardOptions) {
  const pending = new Map<string, PendingProject>();
  const now = options.now ?? Date.now;
  function key(ctx: Context) {
    const message = ctx.message ?? ctx.callbackQuery?.message;
    return `${ctx.chat?.id}:${message?.message_thread_id ?? 0}:${ctx.from?.id}`;
  }
  function current(ctx: Context) {
    const value = pending.get(key(ctx));
    if (value && value.expires <= now()) {
      pending.delete(key(ctx));
      return undefined;
    }
    return value;
  }
  function cancelKeyboard(value: PendingProject) {
    return new InlineKeyboard().text(
      "Annulla",
      `nt_wizard:${value.nonce}:cancel`
    );
  }
  async function prompt(ctx: Context, value: PendingProject, error?: string) {
    const message = await ctx.reply(
      `${NAME_PROMPT}${error ? `${error}\n\n` : ""}Come vuoi chiamare il nuovo progetto? Rispondi a questo messaggio con il nome (es. sito-cliente).`,
      {
        reply_markup: {
          force_reply: true,
          selective: Boolean(ctx.message),
          input_field_placeholder: "nome-progetto",
        },
        ...(ctx.message
          ? { reply_parameters: { message_id: ctx.message.message_id } }
          : {}),
      }
    );
    value.promptId = message.message_id;
  }
  async function begin(ctx: Context) {
    if (ctx.chat?.type === "private") {
      await ctx.reply(
        "Per creare un progetto con il suo argomento, apri il menu nel gruppo Dev."
      );
      return;
    }
    for (const [id, value] of pending) {
      if (value.expires <= now()) {
        pending.delete(id);
      }
    }
    const value: PendingProject = {
      nonce: randomBytes(8).toString("hex"),
      expires: now() + 600_000,
    };
    pending.set(key(ctx), value);
    await prompt(ctx, value);
    await ctx.reply(
      "Puoi annullare la creazione prima di scegliere l'assistente.",
      { reply_markup: cancelKeyboard(value) }
    );
  }
  function isPromptReply(ctx: Context) {
    const reply = ctx.message?.reply_to_message;
    return Boolean(
      reply?.from?.is_bot &&
        reply.from.id === ctx.me?.id &&
        reply.text?.startsWith(NAME_PROMPT)
    );
  }
  function acceptsReply(ctx: Context) {
    const value = current(ctx);
    return (
      isPromptReply(ctx) ||
      Boolean(
        value &&
          !value.name &&
          value.promptId !== undefined &&
          ctx.message?.reply_to_message?.message_id === value.promptId
      )
    );
  }
  async function handleCallback(ctx: Context, data: string): Promise<boolean> {
    const [, nonce, action] = data.split(":");
    const value = current(ctx);
    if (
      !value ||
      value.nonce !== nonce ||
      !["cancel", "claude", "codex"].includes(action ?? "")
    ) {
      await ctx.answerCallbackQuery({
        text: "Procedura scaduta o non disponibile. Riapri Nuovo progetto dal menu.",
        show_alert: true,
      });
      return true;
    }
    if (action === "cancel") {
      pending.delete(key(ctx));
      await ctx.answerCallbackQuery({ text: "Creazione annullata" });
      await ctx.reply("Creazione annullata. Nessuna cartella è stata creata.");
      return true;
    }
    if (!(value.name && ctx.chat)) {
      await ctx.answerCallbackQuery({
        text: "Inserisci prima il nome del progetto.",
      });
      return true;
    }
    // Consume before the first await: repeated Telegram clicks cannot create twice.
    pending.delete(key(ctx));
    await ctx.answerCallbackQuery();
    let folderCreated = false;
    let text: string;
    try {
      const path = createProjectFolder(options.projectsDir, value.name);
      folderCreated = true;
      const created = await options.createTopic(
        ctx,
        ctx.chat.id,
        value.name,
        action as ProviderId
      );
      text = `Progetto creato: ${value.name}\nCartella: ${path}\nCreato l'argomento "${created.name}". Aprilo e scrivi.`;
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "Creazione non riuscita.";
      text = folderCreated
        ? `La cartella ${value.name} è stata conservata, ma non posso confermare la creazione dell'argomento. ${detail}\nControlla /elenco e gli argomenti del gruppo: se l'argomento esiste, aprilo; altrimenti usa /nuova e scegli il progetto esistente.`
        : `${detail}\nRiapri Nuovo progetto dal menu oppure scegli un progetto esistente con /nuova.`;
    }
    await ctx.reply(text);
    return true;
  }
  async function handle(ctx: Context): Promise<boolean> {
    const data = ctx.callbackQuery?.data;
    if (data?.startsWith("nt_wizard:")) {
      return handleCallback(ctx, data);
    }
    if (!acceptsReply(ctx)) {
      return false;
    }
    const value = current(ctx);
    if (
      !value ||
      value.name ||
      value.promptId !== ctx.message?.reply_to_message?.message_id
    ) {
      await ctx.reply(
        "Procedura scaduta o già conclusa. Riapri Nuovo progetto dal menu."
      );
      return true;
    }
    value.promptId = undefined;
    const name = ctx.message?.text?.trim() ?? "";
    try {
      validateProjectName(name);
    } catch (error) {
      await prompt(
        ctx,
        value,
        error instanceof Error ? error.message : "Nome non valido."
      );
      return true;
    }
    value.name = name;
    await ctx.reply(
      `Progetto: ${name}\nScegli l'assistente. Creerò la cartella e il nuovo argomento dopo la scelta.`,
      {
        reply_markup: new InlineKeyboard()
          .text("Claude", `nt_wizard:${value.nonce}:claude`)
          .text("Codex", `nt_wizard:${value.nonce}:codex`)
          .row()
          .text("Annulla", `nt_wizard:${value.nonce}:cancel`),
      }
    );
    return true;
  }
  return { begin, acceptsReply, handle };
}
