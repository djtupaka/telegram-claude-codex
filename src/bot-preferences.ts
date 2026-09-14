import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { type Bot, type Context, InlineKeyboard } from "grammy";
import { getProvider } from "./agent/registry";
import {
  type ProjectPreference,
  projectPreferences,
} from "./project-preferences";

export interface PreferenceTarget extends ProjectPreference {
  projectPath: string;
  scopeKey: string;
}
const PREFERENCE_CALLBACK = /^prefs:(save|remove):([a-f0-9-]+)$/;
export function installBotPreferences(options: {
  bot: Bot;
  getTarget: (ctx: Context) => PreferenceTarget;
  store?: typeof projectPreferences;
}) {
  const store = options.store ?? projectPreferences;
  const pending = new Map<
    string,
    { target: PreferenceTarget; userId?: number; expires: number }
  >();
  const show = async (ctx: Context) => {
    try {
      const target = { ...options.getTarget(ctx) };
      target.projectPath = realpathSync(target.projectPath);
      const saved = store.get(target.projectPath);
      const label = (preference: ProjectPreference) => {
        const provider = getProvider(preference.provider);
        const model =
          preference.model === "default"
            ? provider.defaultModel
            : preference.model;
        const effort =
          preference.effort === "default"
            ? provider.defaultEffort
            : preference.effort;
        const effortLabel =
          provider.effortLevels.find((choice) => choice.id === effort)?.label ??
          effort;
        return `${provider.displayName} · ${model} · ${effortLabel}`;
      };
      for (const [key, value] of pending) {
        if (value.expires <= Date.now()) {
          pending.delete(key);
        }
      }
      if (pending.size >= 500) {
        const oldest = pending.keys().next().value;
        if (oldest) {
          pending.delete(oldest);
        }
      }
      const nonce = randomUUID();
      pending.set(nonce, {
        target,
        userId: ctx.from?.id,
        expires: Date.now() + 600_000,
      });
      const keyboard = new InlineKeyboard().text(
        "Salva impostazioni attuali come preferite",
        `prefs:save:${nonce}`
      );
      if (saved) {
        keyboard.row().text("Rimuovi preferenze", `prefs:remove:${nonce}`);
      }
      keyboard.row().text("Menu", "menu:open");
      await ctx.reply(
        `Preferenze progetto: ${basename(target.projectPath)}\nSalvate: ${saved ? label(saved) : "nessuna"}\nAttuali: ${label(target)}\nLe preferenze valgono per i nuovi argomenti. Le conversazioni esistenti mantengono le proprie impostazioni.`,
        { reply_markup: keyboard }
      );
    } catch {
      await ctx.reply(
        "Preferenze non disponibili. Verifica il progetto e l'archivio delle preferenze; nessuna impostazione è stata modificata."
      );
    }
  };
  options.bot.command("preferenze", show);
  options.bot.callbackQuery(PREFERENCE_CALLBACK, async (ctx) => {
    const match = PREFERENCE_CALLBACK.exec(ctx.callbackQuery.data);
    const nonce = match?.[2] ?? "";
    const item = pending.get(nonce);
    try {
      const current = options.getTarget(ctx);
      if (
        !item ||
        item.expires <= Date.now() ||
        item.userId !== ctx.from?.id ||
        item.target.scopeKey !== current.scopeKey ||
        item.target.projectPath !== realpathSync(current.projectPath)
      ) {
        await ctx.answerCallbackQuery({
          text: "Pulsante scaduto o di un'altra conversazione. Apri /preferenze.",
        });
        return;
      }
      if (match?.[1] === "save") {
        store.set(item.target.projectPath, item.target);
      } else {
        store.remove(item.target.projectPath);
      }
      pending.delete(nonce);
      await ctx.answerCallbackQuery({
        text:
          match?.[1] === "save"
            ? "Preferenze salvate per i nuovi argomenti."
            : "Preferenze rimosse.",
      });
      await ctx
        .editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } })
        .catch(() => undefined);
      await show(ctx);
    } catch {
      await ctx.answerCallbackQuery({
        text: "Operazione non riuscita. L'archivio non è stato sostituito.",
      });
    }
  });
  return { show, store };
}
