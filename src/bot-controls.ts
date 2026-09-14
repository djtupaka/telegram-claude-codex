import { basename } from "node:path";
import type { Bot, Context } from "grammy";
import type { ProviderId } from "./agent/types";
import { ApprovalBroker } from "./approvals";
import {
  calendarDayRange,
  formatStats,
  makeOperationsStore,
} from "./operations";

const APPROVAL_CALLBACK = /^approval:/;

export interface ControlTarget {
  branch: string | null;
  chatId: number;
  effort: string;
  model: string;
  project: string;
  provider: ProviderId;
  runKey: string;
  scopeKey: string;
  threadId?: number;
  userId: number;
}
export function installBotControls(options: {
  bot: Bot;
  store?: ReturnType<typeof makeOperationsStore>;
  getTarget: (ctx: Context) => ControlTarget;
  isBusy: (runKey: string) => boolean;
  activeRunId: (runKey: string) => string | undefined;
}) {
  const { bot, getTarget, isBusy, activeRunId } = options;
  const store = options.store ?? makeOperationsStore();
  const approvals = new ApprovalBroker();
  const summaryPending = new Map<string, Promise<void>>();
  const confirmedPins = new Set<string>();
  const editSummary = async (
    chatId: number,
    messageId: number,
    text: string
  ) => {
    try {
      await bot.api.editMessageText(chatId, messageId, text);
      return true;
    } catch (error) {
      const description = (error as { description?: string }).description ?? "";
      if (description.includes("message is not modified")) {
        return true;
      }
      if (description.includes("message to edit not found")) {
        return false;
      }
      throw error;
    }
  };
  const summary = (target: ControlTarget, status: string): Promise<void> => {
    if (target.threadId === undefined) {
      return Promise.resolve();
    }
    const previous = summaryPending.get(target.scopeKey) ?? Promise.resolve();
    const update = previous
      .catch(() => undefined)
      .then(async () => {
        const settings = store.getSettings(target.scopeKey);
        const text = [
          `Progetto: ${basename(target.project)}`,
          `Branch: ${target.branch ?? "non disponibile"}`,
          `Provider: ${target.provider} · Modello: ${target.model}`,
          `Impegno: ${target.effort}`,
          `Permessi: ${settings.approvalPolicy === "ask" ? "chiedi per ogni strumento (Claude)" : "automatici"}`,
          `Stato: ${status}`,
        ].join("\n");
        let messageId = settings.pinnedMessageId;
        if (messageId && !(await editSummary(target.chatId, messageId, text))) {
          messageId = undefined;
        }
        if (!messageId) {
          const message = await bot.api.sendMessage(target.chatId, text, {
            message_thread_id: target.threadId,
          });
          messageId = message.message_id;
          store.patchSettings(target.scopeKey, { pinnedMessageId: messageId });
        }
        const pinKey = `${target.scopeKey}:${messageId}`;
        if (!confirmedPins.has(pinKey)) {
          await bot.api.pinChatMessage(target.chatId, messageId, {
            disable_notification: true,
          });
          confirmedPins.add(pinKey);
        }
      });
    summaryPending.set(target.scopeKey, update);
    return update.finally(() => {
      if (summaryPending.get(target.scopeKey) === update) {
        summaryPending.delete(target.scopeKey);
      }
    });
  };
  bot.command("permessi", async (ctx) => {
    const target = getTarget(ctx);
    const argument = String(ctx.match ?? "").trim();
    if (!argument) {
      await ctx.reply(
        `Permessi: ${store.getSettings(target.scopeKey).approvalPolicy === "ask" ? "chiedi" : "automatici"}.\n/permessi chiedi — approva ogni strumento con Claude\n/permessi automatici — esecuzione senza pulsanti di conferma\nCodex non supporta le approvazioni Telegram: con «chiedi» resta bloccato.`
      );
      return;
    }
    if (!["chiedi", "automatici"].includes(argument)) {
      await ctx.reply("Usa /permessi chiedi oppure /permessi automatici.");
      return;
    }
    if (isBusy(target.runKey)) {
      await ctx.reply(
        "C'è un'esecuzione attiva. Attendi la conclusione o usa /stop prima di cambiare i permessi."
      );
      return;
    }
    store.patchSettings(target.scopeKey, {
      approvalPolicy: argument === "chiedi" ? "ask" : "automatic",
    });
    await ctx.reply(
      `Permessi aggiornati per questa conversazione: ${argument}.`
    );
  });
  bot.command("stats", async (ctx) => {
    const target = getTarget(ctx);
    const argument = String(ctx.match ?? "").trim();
    try {
      if (argument === "tutto") {
        await ctx.reply(
          `Storico registrato · questa conversazione\n${formatStats(store.stats(target.scopeKey))}`
        );
        return;
      }
      const day =
        argument ||
        new Intl.DateTimeFormat("en-CA", {
          timeZone: "Europe/Rome",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date());
      const range = calendarDayRange(day);
      await ctx.reply(
        `${day} · Europe/Rome · questa conversazione\n${formatStats(store.stats(target.scopeKey, range.since, range.until))}`
      );
    } catch {
      await ctx.reply(
        "Usa /stats per oggi, /stats AAAA-MM-GG per un giorno o /stats tutto per lo storico registrato."
      );
    }
  });
  bot.command("riepilogo", async (ctx) => {
    const target = getTarget(ctx);
    if (target.threadId === undefined) {
      await ctx.reply(
        "Il riepilogo fissato è disponibile negli argomenti del gruppo. In privato usa /status."
      );
      return;
    }
    try {
      await summary(target, isBusy(target.runKey) ? "In esecuzione" : "Libero");
    } catch {
      await ctx.reply(
        "Non riesco ad aggiornare il riepilogo. Verifica che il bot possa fissare i messaggi nell'argomento."
      );
    }
  });
  bot.callbackQuery(APPROVAL_CALLBACK, async (ctx) => {
    const target = getTarget(ctx);
    const runId = activeRunId(target.runKey);
    const accepted =
      runId && approvals.resolve(ctx.callbackQuery.data, { ...target, runId });
    await ctx.answerCallbackQuery({
      text: accepted
        ? "Risposta registrata."
        : "Richiesta scaduta o appartenente a un'altra esecuzione.",
    });
    if (accepted) {
      await ctx
        .editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } })
        .catch(() => undefined);
    }
  });
  return { approvals, store, summary, stop: () => approvals.cancelAll() };
}
