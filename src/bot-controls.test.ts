import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot, Context } from "grammy";
import { installBotControls } from "./bot-controls";
import { makeOperationsStore } from "./operations";

test("policy stays scoped and cannot change while a run is active", async () => {
  const commands = new Map<string, (ctx: Context) => Promise<void>>();
  const ops = makeOperationsStore(
    join(mkdtempSync(join(tmpdir(), "controls-")), "ops.json")
  );
  let busy = false;
  const replies: string[] = [];
  const bot = {
    command: (name: string, handler: (ctx: Context) => Promise<void>) =>
      commands.set(name, handler),
    callbackQuery: () => undefined,
  } as unknown as Bot;
  installBotControls({
    bot,
    store: ops,
    getTarget: () => ({
      scopeKey: "t:-1:2",
      runKey: "t:-1:2",
      chatId: -1,
      threadId: 2,
      userId: 7,
      project: "/p/a",
      provider: "claude",
      model: "default",
      effort: "high",
      branch: "main",
    }),
    isBusy: () => busy,
    activeRunId: () => undefined,
  });
  const ctx = {
    match: "chiedi",
    reply: async (text: string) => {
      replies.push(text);
    },
  } as unknown as Context;
  await commands.get("permessi")?.(ctx);
  expect(ops.getSettings("t:-1:2").approvalPolicy).toBe("ask");
  expect(ops.getSettings("t:-1:3").approvalPolicy).toBe("automatic");
  busy = true;
  await commands.get("permessi")?.({ ...ctx, match: "automatici" } as Context);
  expect(ops.getSettings("t:-1:2").approvalPolicy).toBe("ask");
  expect(replies.at(-1)).toContain("attiva");
});

test("summary edits its own message and never unpins other messages", async () => {
  const ops = makeOperationsStore(
    join(mkdtempSync(join(tmpdir(), "summary-")), "ops.json")
  );
  const calls: string[] = [];
  const bot = {
    command: () => undefined,
    callbackQuery: () => undefined,
    api: {
      sendMessage: async (
        _chat: number,
        _text: string,
        options: { message_thread_id: number }
      ) => {
        expect(options.message_thread_id).toBe(2);
        expect(JSON.stringify(options)).toContain("menu:open");
        calls.push("send");
        return { message_id: 44 };
      },
      pinChatMessage: async () => {
        calls.push("pin");
      },
      editMessageText: async (_chat: number, id: number) => {
        expect(id).toBe(44);
        calls.push("edit");
      },
    },
  } as unknown as Bot;
  const controls = installBotControls({
    bot,
    store: ops,
    getTarget: () => {
      throw new Error("unused");
    },
    isBusy: () => false,
    activeRunId: () => undefined,
  });
  const target = {
    scopeKey: "t:-1:2",
    runKey: "t:-1:2",
    chatId: -1,
    threadId: 2,
    userId: 7,
    project: "/p/a",
    provider: "claude" as const,
    model: "default",
    effort: "high",
    branch: "main",
  };
  await controls.summary(target, "Libero");
  await controls.summary(target, "In esecuzione");
  expect(calls).toEqual(["send", "pin", "edit"]);
});

test("a pin failure keeps one summary message and retries without duplicating it", async () => {
  const ops = makeOperationsStore(
    join(mkdtempSync(join(tmpdir(), "summary-pin-")), "ops.json")
  );
  let sent = 0;
  let pinned = 0;
  const bot = {
    command: () => undefined,
    callbackQuery: () => undefined,
    api: {
      sendMessage: async () => ({ message_id: ++sent }),
      editMessageText: async () => undefined,
      pinChatMessage: async () => {
        if (++pinned === 1) {
          throw new Error("missing permission");
        }
      },
    },
  } as unknown as Bot;
  const controls = installBotControls({
    bot,
    store: ops,
    getTarget: () => {
      throw new Error("unused");
    },
    isBusy: () => false,
    activeRunId: () => undefined,
  });
  const target = {
    scopeKey: "t:-1:2",
    runKey: "t:-1:2",
    chatId: -1,
    threadId: 2,
    userId: 7,
    project: "/p/a",
    provider: "claude" as const,
    model: "default",
    effort: "high",
    branch: "main",
  };
  await expect(controls.summary(target, "Libero")).rejects.toThrow(
    "missing permission"
  );
  await controls.summary(target, "Libero");
  expect(sent).toBe(1);
  expect(pinned).toBe(2);
});
