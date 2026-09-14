import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot, Context } from "grammy";
import { scanAttachments } from "./attachment-manager";
import { storeAttachment } from "./attachments";
import { installAttachmentManager } from "./bot-attachments";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((p) => rm(p, { recursive: true, force: true }))
  );
});
test("callback confirmation requires same user/project, preview and idle context", async () => {
  const projectPath = await mkdtemp(join(tmpdir(), "attachment-ui-"));
  dirs.push(projectPath);
  const location = {
    projectPath,
    rootDir: join(projectPath, "archive"),
    scopeKey: "private",
    busy: false,
  };
  await storeAttachment({
    ...location,
    data: new TextEncoder().encode("hello"),
    originalName: "test.pdf",
    mimeType: "application/pdf",
    telegramFileId: "x",
  });
  type Handler = (ctx: Context) => Promise<void>;
  let command: Handler | undefined;
  let callback: Handler | undefined;
  const bot = {
    command: (_name: string, handler: Handler) => {
      command = handler;
    },
    callbackQuery: (_pattern: RegExp, handler: Handler) => {
      callback = handler;
    },
  } as unknown as Bot;
  installAttachmentManager({ bot, context: () => location });
  const messages: Array<{
    text: string;
    options?: {
      reply_markup?: {
        inline_keyboard: Array<Array<{ callback_data?: string }>>;
      };
    };
  }> = [];
  const alerts: unknown[] = [];
  const ctx = {
    from: { id: 1 },
    chat: { id: 1 },
    match: "",
    msg: {},
    callbackQuery: { data: "" },
    reply: async (text: string, options: unknown) => {
      messages.push({ text, options: options as never });
    },
    editMessageText: async (text: string, options: unknown) => {
      messages.push({ text, options: options as never });
    },
    answerCallbackQuery: async (value: unknown) => {
      alerts.push(value);
    },
  };
  if (!(command && callback)) {
    throw new Error("Handlers missing");
  }
  await command(ctx as unknown as Context);
  const data =
    messages[0]?.options?.reply_markup?.inline_keyboard[0]?.[0]?.callback_data;
  if (!data) {
    throw new Error("Missing callback");
  }
  ctx.callbackQuery.data = data.replace(":detail:", ":confirm:");
  await callback(ctx as unknown as Context);
  expect((await scanAttachments(location)).entries[0]?.archived).toBe(false);
  ctx.from.id = 2;
  ctx.callbackQuery.data = data;
  await callback(ctx as unknown as Context);
  expect(JSON.stringify(alerts)).toContain("scaduta");
  ctx.from.id = 1;
  ctx.callbackQuery.data = data.replace(":detail:", ":preview:");
  await callback(ctx as unknown as Context);
  location.busy = true;
  ctx.callbackQuery.data = data.replace(":detail:", ":confirm:");
  await callback(ctx as unknown as Context);
  expect((await scanAttachments(location)).entries[0]?.archived).toBe(false);
  location.busy = false;
  await callback(ctx as unknown as Context);
  expect((await scanAttachments(location)).entries[0]?.archived).toBe(true);
  await command(ctx as unknown as Context);
  const latest =
    messages.at(-1)?.options?.reply_markup?.inline_keyboard[0]?.[0]
      ?.callback_data;
  if (!latest) {
    throw new Error("Missing fresh callback");
  }
  ctx.callbackQuery.data = latest.replace(":detail:", ":purgeconfirm:");
  await callback(ctx as unknown as Context);
  expect((await scanAttachments(location)).entries).toHaveLength(1);
  ctx.callbackQuery.data = latest.replace(":detail:", ":purge:");
  await callback(ctx as unknown as Context);
  expect(messages.at(-1)?.text).toContain("senza backup");
  ctx.callbackQuery.data = latest.replace(":detail:", ":purgeconfirm:");
  ctx.from.id = 2;
  await callback(ctx as unknown as Context);
  expect((await scanAttachments(location)).entries).toHaveLength(1);
  ctx.from.id = 1;
  await callback(ctx as unknown as Context);
  expect((await scanAttachments(location)).entries).toHaveLength(0);
  await callback(ctx as unknown as Context);
  expect(JSON.stringify(alerts)).toContain("scaduta");
});
