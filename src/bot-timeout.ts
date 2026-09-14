import { type Bot, type Context, InlineKeyboard } from "grammy";
import { makeOperationsStore } from "./operations";

const MINUTE_MS = 60_000;
const MAX_MINUTES = 1440;
const MINUTES = /^\d+$/;
const CALLBACK = /^timeout:(menu|off|15|30|60|predefinito|custom)$/;
const HELP =
  "Usa /timeout off, /timeout predefinito oppure /timeout seguito da un numero intero di minuti da 1 a 1440 (per esempio /timeout 45).";
const durationLabel = (value: number | null | undefined) =>
  value == null ? "disattivato" : `${value / MINUTE_MS} minuti`;

/** Install after authorization and conversation scope middleware. */
export function installBotTimeout(options: {
  bot: Bot;
  getScopeKey: (ctx: Context) => string;
  store?: ReturnType<typeof makeOperationsStore>;
  defaultTimeoutMs?: number | null;
}) {
  const store = options.store ?? makeOperationsStore();
  const show = async (ctx: Context) => {
    const value = store.getSettings(options.getScopeKey(ctx)).runTimeoutMs;
    const label =
      value === undefined
        ? `predefinito (${durationLabel(options.defaultTimeoutMs)})`
        : durationLabel(value);
    const keyboard = new InlineKeyboard()
      .text("Disattivato", "timeout:off")
      .text("15 minuti", "timeout:15")
      .row()
      .text("30 minuti", "timeout:30")
      .text("60 minuti", "timeout:60")
      .row()
      .text("Personalizzato", "timeout:custom")
      .text("Predefinito", "timeout:predefinito")
      .row()
      .text("Menu", "menu:open");
    await ctx.reply(
      `Timeout di questa conversazione: ${label}.\nLimita la durata totale di ogni esecuzione, anche mentre l'agente lavora. Vale per le prossime esecuzioni; quella già attiva mantiene il suo limite.\n${HELP}`,
      { reply_markup: keyboard }
    );
  };
  const apply = async (ctx: Context, input: string) => {
    let value: number | null | undefined;
    if (input === "off") {
      value = null;
    } else if (input === "predefinito") {
      value = undefined;
    } else {
      const minutes = Number(input);
      if (
        !(
          MINUTES.test(input) &&
          Number.isSafeInteger(minutes) &&
          minutes >= 1 &&
          minutes <= MAX_MINUTES
        )
      ) {
        await ctx.reply(HELP);
        return;
      }
      value = minutes * MINUTE_MS;
    }
    store.patchSettings(options.getScopeKey(ctx), { runTimeoutMs: value });
    await show(ctx);
  };
  options.bot.command("timeout", async (ctx) => {
    try {
      const input = String(ctx.match ?? "")
        .trim()
        .toLowerCase();
      if (input) {
        await apply(ctx, input);
      } else {
        await show(ctx);
      }
    } catch {
      await ctx.reply(
        "Timeout non disponibile: verifica l'archivio delle impostazioni."
      );
    }
  });
  options.bot.callbackQuery(CALLBACK, async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const action = ctx.callbackQuery.data.slice("timeout:".length);
      if (action === "menu") {
        await show(ctx);
      } else if (action === "custom") {
        await ctx.reply(HELP);
      } else {
        await apply(ctx, action);
      }
    } catch {
      await ctx.reply(
        "Timeout non disponibile: verifica l'archivio delle impostazioni."
      );
    }
  });
  return { show, store };
}
