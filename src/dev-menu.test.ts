import { expect, test } from "bun:test";
import {
  buildDevMenu,
  buildTopicNavigation,
  menuActionCommand,
  topicLink,
} from "./dev-menu";

test("General offers navigation, not session settings", () => {
  const menu = buildDevMenu({ kind: "control" });
  const buttons = JSON.stringify(menu.keyboard);
  expect(buttons).toContain("menu:topics:0");
  expect(buttons).toContain("menu:pin");
  expect(buttons).toContain("menu:run:nuova");
  expect(buttons).not.toContain("menu:settings");
  expect(menuActionCommand("control", "provider")).toBeUndefined();
  expect(menuActionCommand("control", "stop")).toBeUndefined();
  expect(menuActionCommand("control", "nuova")).toBe("nuova");
});
test("topic menu shows its context and quick actions", () => {
  const menu = buildDevMenu({
    kind: "topic",
    project: "PremelOne",
    provider: "Codex",
    model: "Astra",
    effort: "high",
    running: true,
    queued: 2,
  });
  expect(menu.text).toContain("PremelOne");
  expect(menu.text).toContain("Astra");
  expect(menu.text).toContain("2");
  expect(JSON.stringify(menu.keyboard)).toContain("menu:settings");
  expect(menuActionCommand("topic", "stop")).toBe("stop");
  expect(menuActionCommand("topic", "rm -rf /")).toBeUndefined();
});
test("topic navigation stays inside this group with pagination and active filtering", () => {
  const topics = Array.from({ length: 15 }, (_, i) => ({
    name: `Project ${i}`,
    chatId: -100_123_456,
    threadId: i + 2,
    running: i === 0,
  }));
  topics.push({
    name: "Other group",
    chatId: -100_999_999,
    threadId: 50,
    running: true,
  });
  const page = buildTopicNavigation(-100_123_456, topics, 0, false);
  expect(JSON.stringify(page.keyboard)).not.toContain("Other group");
  expect(JSON.stringify(page.keyboard)).toContain("menu:topics:1");
  const active = buildTopicNavigation(-100_123_456, topics, 0, true);
  expect(active.text).toContain("1");
  expect(JSON.stringify(active.keyboard)).not.toContain("Project 1");
  expect(topicLink(-100_123_456, 12)).toBe("https://t.me/c/123456/12");
});

test("group command keyboards get a menu return while private and approvals are preserved", async () => {
  const { menuReplyTransformer } = await import("./dev-menu");
  const output: unknown[] = [];
  const previous = async (_method: string, payload: unknown) => {
    output.push(payload);
    return { ok: true as const, result: true };
  };
  await menuReplyTransformer(previous as never, "sendMessage", {
    chat_id: -100_123_456,
    text: "status",
    reply_markup: { keyboard: [[{ text: "Projects" }]] },
  });
  expect(JSON.stringify(output.pop())).toContain("menu:open");
  const privatePayload = {
    chat_id: 42,
    text: "status",
    reply_markup: { keyboard: [[{ text: "Projects" }]] },
  };
  await menuReplyTransformer(previous as never, "sendMessage", privatePayload);
  expect(output.pop()).toEqual(privatePayload);
  const approval = {
    chat_id: -100_123_456,
    text: "approve",
    reply_markup: {
      inline_keyboard: [
        [{ text: "Approve", callback_data: "approval:abc:allow" }],
      ],
    },
  };
  await menuReplyTransformer(previous as never, "sendMessage", approval);
  expect(output.pop()).toEqual(approval);
  await menuReplyTransformer(previous as never, "sendMessage", {
    chat_id: -100_123_456,
    text: "model",
    reply_markup: {
      inline_keyboard: [[{ text: "Astra", callback_data: "model:astra" }]],
    },
  });
  expect(JSON.stringify(output.pop())).toContain("menu:open");
});
