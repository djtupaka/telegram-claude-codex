import { expect, test } from "bun:test";
import { ApprovalBroker, type ApprovalPrompt } from "./approvals";

const scope = {
  userId: 1,
  chatId: -2,
  threadId: 3,
  runId: "run",
  runKey: "topic",
};
const request = (signal = new AbortController().signal) => ({
  toolName: "Bash",
  input: { command: "echo <script>&" },
  toolUseId: "tool",
  signal,
});

test("approval binds user, chat, thread and active run, and is single use", async () => {
  const broker = new ApprovalBroker();
  let prompt!: ApprovalPrompt;
  const pending = broker.request(scope, request(), async (value) => {
    prompt = value;
  });
  const data = prompt.replyMarkup.inline_keyboard[0]?.[0]?.callback_data ?? "";
  for (const patch of [
    { userId: 2 },
    { chatId: -3 },
    { threadId: 4 },
    { runId: "old" },
    { runKey: "other" },
  ]) {
    expect(broker.resolve(data, { ...scope, ...patch })).toBe(false);
  }
  expect(broker.resolve(data, scope)).toBe(true);
  expect(await pending).toBe(true);
  expect(broker.resolve(data, scope)).toBe(false);
  expect(prompt.text).toContain("&lt;script&gt;&amp;");
});

test("timeout, cancellation, abort and publication errors deny", async () => {
  const broker = new ApprovalBroker(5);
  expect(await broker.request(scope, request(), async () => undefined)).toBe(
    false
  );
  const pending = broker.request(scope, request(), async () => undefined);
  broker.cancelRun(scope.runId);
  expect(await pending).toBe(false);
  const controller = new AbortController();
  controller.abort();
  let published = false;
  expect(
    await broker.request(scope, request(controller.signal), async () => {
      published = true;
    })
  ).toBe(false);
  expect(published).toBe(false);
  expect(
    await broker.request(scope, request(), async () => {
      throw new Error("offline");
    })
  ).toBe(false);
});

test("abort while waiting and cancelAll revoke pending approvals", async () => {
  const broker = new ApprovalBroker();
  const controller = new AbortController();
  const pending = broker.request(
    scope,
    request(controller.signal),
    async () => undefined
  );
  controller.abort();
  expect(await pending).toBe(false);
  const another = broker.request(scope, request(), async () => undefined);
  broker.cancelAll();
  expect(await another).toBe(false);
});

test("oversized input is capped and cannot be approved unseen", async () => {
  const broker = new ApprovalBroker();
  let prompt!: ApprovalPrompt;
  const pending = broker.request(
    scope,
    { ...request(), input: { command: "x".repeat(10_000) } },
    async (value) => {
      prompt = value;
    }
  );
  expect(prompt.text.length).toBeLessThan(4000);
  expect(
    prompt.replyMarkup.inline_keyboard
      .flat()
      .some((button) => button.callback_data.endsWith(":allow"))
  ).toBe(false);
  broker.cancelAll();
  expect(await pending).toBe(false);
});
