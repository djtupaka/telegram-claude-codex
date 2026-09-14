import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot, Context } from "grammy";
import { installBotPreferences } from "./bot-preferences";
import { makeProjectPreferencesStore } from "./project-preferences";

test("preferences buttons save a snapshot, reject cross-scope callbacks and remove", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-preferences-"));
  try {
    const store = makeProjectPreferencesStore(join(dir, "prefs.json"));
    let callback: (ctx: Context) => Promise<void> = async () => undefined;
    let buttons = "";
    let text = "";
    let scopeKey = "t:-1:2";
    const target = {
      projectPath: dir,
      provider: "codex" as const,
      model: "default",
      effort: "high",
    };
    const bot = {
      command: () => undefined,
      callbackQuery: (_pattern: RegExp, fn: typeof callback) => {
        callback = fn;
      },
    } as unknown as Bot;
    const ui = installBotPreferences({
      bot,
      store,
      getTarget: () => ({ ...target, scopeKey }),
    });
    const ctx = {
      from: { id: 7 },
      reply: async (_text: string, options: unknown) => {
        buttons = JSON.stringify(options);
        text = _text;
      },
      answerCallbackQuery: async () => undefined,
      editMessageReplyMarkup: async () => undefined,
    } as unknown as Context;
    await ui.show(ctx);
    expect(text).toContain("Alto");
    const save =
      (
        JSON.parse(buttons).reply_markup.inline_keyboard.flat() as {
          callback_data: string;
        }[]
      ).find((b) => b.callback_data.includes(":save:"))?.callback_data ??
      "missing";
    const clicked = {
      ...ctx,
      callbackQuery: { data: save },
    } as unknown as Context;
    scopeKey = "t:-1:3";
    await callback(clicked);
    expect(store.get(dir)).toBeUndefined();
    scopeKey = "t:-1:2";
    await callback({ ...clicked, from: { id: 99 } } as unknown as Context);
    expect(store.get(dir)).toBeUndefined();
    await callback(clicked);
    expect(store.get(dir)).toEqual({
      provider: "codex",
      model: "default",
      effort: "high",
    });
    await ui.show(ctx);
    const remove =
      (
        JSON.parse(buttons).reply_markup.inline_keyboard.flat() as {
          callback_data: string;
        }[]
      ).find((b) => b.callback_data.includes(":remove:"))?.callback_data ??
      "missing";
    await callback({
      ...ctx,
      callbackQuery: { data: remove },
    } as unknown as Context);
    expect(store.get(dir)).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
