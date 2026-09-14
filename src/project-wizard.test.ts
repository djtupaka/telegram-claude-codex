import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "grammy";
import { createProjectWizard } from "./project-wizard";

function harness() {
  const root = mkdtempSync(join(tmpdir(), "wizard-"));
  let time = 100;
  let id = 10;
  const sent: { text: string; options: any; message_id: number }[] = [];
  const topics: string[] = [];
  let fail = false;
  const wizard = createProjectWizard({
    projectsDir: root,
    now: () => time,
    createTopic: async (_ctx, _chat, name, provider) => {
      topics.push(`${name}:${provider}`);
      if (fail) {
        throw new Error("Telegram unavailable");
      }
      return { name };
    },
  });
  function ctx(extra: Record<string, unknown> = {}) {
    return {
      chat: { id: -100, type: "supergroup" },
      from: { id: 42 },
      message: { message_id: 1, message_thread_id: 8 },
      reply: async (text: string, options: unknown) => {
        const message = { text, options, message_id: ++id };
        sent.push(message);
        return message;
      },
      answerCallbackQuery: async () => undefined,
      ...extra,
    } as unknown as Context;
  }
  const reply = (text: string, prompt: number, thread = 8) =>
    ctx({
      message: {
        text,
        message_thread_id: thread,
        reply_to_message: { message_id: prompt },
      },
    });
  const callback = (data: string, user = 42) =>
    ctx({
      from: { id: user },
      message: undefined,
      callbackQuery: { data, message: { message_thread_id: 8 } },
    });
  const buttons = () =>
    sent.flatMap((m) => m.options?.reply_markup?.inline_keyboard?.flat() ?? []);
  const prompt = () =>
    sent.findLast((m) => m.options?.reply_markup?.force_reply)
      ?.message_id as number;
  return {
    root,
    wizard,
    sent,
    topics,
    ctx,
    reply,
    callback,
    buttons,
    prompt,
    expire: () => {
      time += 600_001;
    },
    fail: () => {
      fail = true;
    },
  };
}

test("guided name and assistant flow creates once, only after choice", async () => {
  const h = harness();
  try {
    await h.wizard.begin(h.ctx());
    expect(h.prompt()).toBeGreaterThan(0);
    expect(h.wizard.acceptsReply(h.reply("demo", h.prompt()))).toBe(true);
    expect(h.wizard.acceptsReply(h.reply("demo", h.prompt() + 100))).toBe(
      false
    );
    expect(h.wizard.acceptsReply(h.reply("demo", h.prompt(), 9))).toBe(false);
    await h.wizard.handle(h.reply("demo", h.prompt()));
    expect(readdirSync(h.root)).toEqual([]);
    const choice = h
      .buttons()
      .find((b) => b.callback_data.endsWith(":codex")).callback_data;
    await Promise.all([
      h.wizard.handle(h.callback(choice)),
      h.wizard.handle(h.callback(choice)),
    ]);
    expect(h.topics).toEqual(["demo:codex"]);
    expect(existsSync(join(h.root, "demo"))).toBe(true);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("invalid names reprompt; cancellation, foreign and stale choices never write", async () => {
  const h = harness();
  try {
    await h.wizard.begin(h.ctx());
    const old = h.prompt();
    await h.wizard.handle(h.reply("../bad", old));
    expect(h.prompt()).not.toBe(old);
    await h.wizard.handle(h.reply("demo", h.prompt()));
    const choice = h
      .buttons()
      .find((b) => b.callback_data.endsWith(":claude")).callback_data;
    await h.wizard.handle(h.callback(choice, 99));
    expect(readdirSync(h.root)).toEqual([]);
    await h.wizard.begin(h.ctx());
    await h.wizard.handle(h.callback(choice));
    expect(readdirSync(h.root)).toEqual([]);
    const cancel = h
      .buttons()
      .findLast((b) => b.callback_data.endsWith(":cancel")).callback_data;
    await h.wizard.handle(h.callback(cancel));
    expect(h.wizard.acceptsReply(h.reply("demo", h.prompt()))).toBe(false);
    expect(readdirSync(h.root)).toEqual([]);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("expiration and failed topic creation preserve safe recovery", async () => {
  const h = harness();
  try {
    await h.wizard.begin(h.ctx());
    await h.wizard.handle(h.reply("demo", h.prompt()));
    const choice = h
      .buttons()
      .find((b) => b.callback_data.endsWith(":codex")).callback_data;
    h.expire();
    await h.wizard.handle(h.callback(choice));
    expect(readdirSync(h.root)).toEqual([]);
    await h.wizard.begin(h.ctx());
    await h.wizard.handle(h.reply("demo", h.prompt()));
    const fresh = h
      .buttons()
      .findLast((b) => b.callback_data.endsWith(":codex")).callback_data;
    h.fail();
    await h.wizard.handle(h.callback(fresh));
    await h.wizard.handle(h.callback(fresh));
    expect(h.topics).toEqual(["demo:codex"]);
    expect(existsSync(join(h.root, "demo"))).toBe(true);
    expect(
      h.sent.some(
        (m) => m.text.includes("/nuova") && m.text.includes("conservata")
      )
    ).toBe(true);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("expired prompt replies are consumed without sending the name to the assistant", async () => {
  const h = harness();
  try {
    await h.wizard.begin(h.ctx());
    const prompt = h.sent.find((m) => m.message_id === h.prompt());
    h.expire();
    const stale = h.ctx({
      me: { id: 7 },
      message: {
        text: "demo",
        message_thread_id: 8,
        reply_to_message: {
          message_id: h.prompt(),
          text: prompt?.text,
          from: { id: 7, is_bot: true },
        },
      },
    });
    expect(h.wizard.acceptsReply(stale)).toBe(true);
    expect(await h.wizard.handle(stale)).toBe(true);
    expect(h.sent.at(-1)?.text).toContain("Riapri");
    expect(readdirSync(h.root)).toEqual([]);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});
