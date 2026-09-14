import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot, Context } from "grammy";
import { installBotTimeout } from "./bot-timeout";
import { makeOperationsStore } from "./operations";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "timeout-"));
  dirs.push(dir);
  const store = makeOperationsStore(join(dir, "ops.json"));
  const commands = new Map<string, (ctx: Context) => Promise<void>>();
  const callbacks: {
    pattern: RegExp;
    handler: (ctx: Context) => Promise<void>;
  }[] = [];
  const replies: string[] = [];
  const bot = {
    command: (name: string, handler: (ctx: Context) => Promise<void>) =>
      commands.set(name, handler),
    callbackQuery: (
      pattern: RegExp,
      handler: (ctx: Context) => Promise<void>
    ) => callbacks.push({ pattern, handler }),
  } as unknown as Bot;
  installBotTimeout({
    bot,
    store,
    getScopeKey: (ctx) => String(ctx.chat?.id),
    defaultTimeoutMs: 600_000,
  });
  const ctx = (match: string, id = 1) =>
    ({
      match,
      chat: { id },
      reply: async (text: string) => {
        replies.push(text);
      },
      answerCallbackQuery: async () => undefined,
    }) as unknown as Context;
  return {
    store,
    replies,
    command: (text: string, id?: number) =>
      commands.get("timeout")?.(ctx(text, id)),
    callback: async (data: string, id = 1) => {
      for (const item of callbacks) {
        if (item.pattern.test(data)) {
          await item.handler({
            ...ctx("", id),
            callbackQuery: { data },
          } as Context);
        }
      }
    },
  };
}
test("timeout command persists scoped off, custom minutes and inherited default", async () => {
  const app = setup();
  await app.command("off");
  expect(app.store.getSettings("1").runTimeoutMs).toBeNull();
  expect(app.store.getSettings("2").runTimeoutMs).toBeUndefined();
  await app.command("47");
  expect(app.store.getSettings("1").runTimeoutMs).toBe(2_820_000);
  expect(app.replies.at(-1)).toContain("prossime esecuzioni");
  await app.command("predefinito");
  expect(app.store.getSettings("1").runTimeoutMs).toBeUndefined();
  expect(app.replies.at(-1)).toContain("10 minuti");
});
test("timeout rejects ambiguous or invalid durations without changing settings", async () => {
  const app = setup();
  await app.command("30");
  for (const input of [
    "0",
    "-1",
    "1.5",
    "1441",
    "30 minuti",
    "on",
    "Infinity",
  ]) {
    await app.command(input);
    expect(app.store.getSettings("1").runTimeoutMs).toBe(1_800_000);
    expect(app.replies.at(-1)).toContain("1 a 1440");
  }
});
test("timeout menu and custom help do not mutate; quick buttons update only current scope", async () => {
  const app = setup();
  await app.callback("timeout:menu");
  await app.callback("timeout:custom");
  expect(app.store.getSettings("1").runTimeoutMs).toBeUndefined();
  expect(app.replies.at(-1)).toContain("/timeout 45");
  await app.callback("timeout:15", 2);
  expect(app.store.getSettings("2").runTimeoutMs).toBe(900_000);
  expect(app.store.getSettings("1").runTimeoutMs).toBeUndefined();
  await app.callback("timeout:off", 2);
  expect(app.store.getSettings("2").runTimeoutMs).toBeNull();
  await app.callback("timeout:predefinito", 2);
  expect(app.store.getSettings("2").runTimeoutMs).toBeUndefined();
});
