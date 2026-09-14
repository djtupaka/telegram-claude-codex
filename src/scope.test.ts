import { describe, expect, test } from "bun:test";
import {
  resolveScope,
  sessionProjectKey,
  threadTransformer,
  topicKey,
} from "./scope";

const allowed = new Set([-1_004_307_670_930]);

describe("resolveScope", () => {
  test("private chat keeps the user-keyed scope", () => {
    const scope = resolveScope(
      { chat: { id: 74_919_235, type: "private" }, from: { id: 74_919_235 } },
      allowed
    );
    expect(scope).toEqual({
      kind: "private",
      key: "u:74919235",
      chatId: 74_919_235,
      userId: 74_919_235,
    });
  });

  test("topic message in an allowed group gets its own key", () => {
    const scope = resolveScope(
      {
        chat: { id: -1_004_307_670_930, type: "supergroup" },
        from: { id: 74_919_235 },
        msg: { is_topic_message: true, message_thread_id: 42 },
      },
      allowed
    );
    expect(scope?.kind).toBe("topic");
    expect(scope?.key).toBe(topicKey(-1_004_307_670_930, 42));
    expect(scope?.threadId).toBe(42);
  });

  test("General area of an allowed group is control-only", () => {
    const scope = resolveScope(
      {
        chat: { id: -1_004_307_670_930, type: "supergroup" },
        from: { id: 74_919_235 },
        msg: {},
      },
      allowed
    );
    expect(scope?.kind).toBe("control");
  });

  test("groups outside the allow-list are denied", () => {
    const scope = resolveScope(
      {
        chat: { id: -1001, type: "supergroup" },
        from: { id: 74_919_235 },
        msg: { is_topic_message: true, message_thread_id: 7 },
      },
      allowed
    );
    expect(scope?.kind).toBe("denied");
  });

  test("channels are denied and missing sender is undefined", () => {
    expect(
      resolveScope(
        { chat: { id: -100, type: "channel" }, from: { id: 1 } },
        allowed
      )?.kind
    ).toBe("denied");
    expect(
      resolveScope({ chat: { id: 1, type: "private" } }, allowed)
    ).toBeUndefined();
  });
});

describe("sessionProjectKey", () => {
  test("private scope keeps the plain project path", () => {
    expect(sessionProjectKey(undefined, "/p/x")).toBe("/p/x");
  });
  test("topic scope suffixes the project with the topic key", () => {
    expect(sessionProjectKey("t:-1:5", "/p/x")).toBe("/p/x#t:-1:5");
  });
});

describe("threadTransformer", () => {
  const calls: { method: string; payload: unknown }[] = [];
  const prev = (method: string, payload: unknown) => {
    calls.push({ method, payload });
    return Promise.resolve({ ok: true as const, result: true });
  };
  const tx = threadTransformer(-5, 9);

  test("adds message_thread_id to send methods for the topic chat", async () => {
    calls.length = 0;
    await tx(prev as never, "sendMessage", { chat_id: -5, text: "hi" });
    expect(calls[0]?.payload).toEqual({
      chat_id: -5,
      text: "hi",
      message_thread_id: 9,
    });
  });

  test("respects an explicit thread id and other chats", async () => {
    calls.length = 0;
    await tx(prev as never, "sendMessage", {
      chat_id: -5,
      text: "x",
      message_thread_id: 3,
    });
    await tx(prev as never, "sendMessage", { chat_id: 77, text: "y" });
    await tx(prev as never, "editMessageText", { chat_id: -5, text: "z" });
    expect(calls.map((c) => c.payload)).toEqual([
      { chat_id: -5, text: "x", message_thread_id: 3 },
      { chat_id: 77, text: "y" },
      { chat_id: -5, text: "z" },
    ]);
  });
});
