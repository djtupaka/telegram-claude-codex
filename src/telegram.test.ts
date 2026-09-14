import { describe, expect, test } from "bun:test";
import type { Context } from "grammy";
import { AgentInterrupted, ProviderCrashed } from "./agent/errors";
import type { AgentEvent, ProviderCapabilities } from "./agent/types";
import { splitText, streamToTelegram } from "./telegram";

const FULL_CAPS: ProviderCapabilities = {
  cost: true,
  planMode: true,
  subagents: true,
  thinking: true,
};

/** Rich message bodies are either raw markdown or pre-rendered Telegram HTML. */
type RichInput = { markdown: string } | { html: string };
const bodyOf = (input: RichInput) =>
  "markdown" in input ? input.markdown : input.html;

/** A recording fake of the grammy ctx/api — no network, captures every send. */
const makeFakeCtx = (chatId = 1) => {
  const rich: RichInput[] = [];
  const drafts: RichInput[] = [];
  const plain: string[] = [];
  let idSeq = 100;
  const api = {
    sendRichMessage: (_chatId: number, input: RichInput) => {
      rich.push(input);
      idSeq += 1;
      return Promise.resolve({ message_id: idSeq });
    },
    sendRichMessageDraft: (
      _chatId: number,
      _draftId: number,
      input: RichInput
    ) => {
      drafts.push(input);
      return Promise.resolve(undefined);
    },
    sendMessage: (_chatId: number, text: string) => {
      plain.push(text);
      idSeq += 1;
      return Promise.resolve({ message_id: idSeq });
    },
    sendChatAction: () => Promise.resolve(true),
  };
  const ctx = { chat: { id: chatId }, api } as unknown as Context;
  return { ctx, rich, drafts, plain };
};

async function* scripted(events: AgentEvent[]) {
  for (const event of events) {
    yield event;
  }
}

const run = (
  events: AgentEvent[],
  caps: ProviderCapabilities = FULL_CAPS,
  projectName = "proj",
  options?: Parameters<typeof streamToTelegram>[4]
) => {
  const fake = makeFakeCtx();
  return streamToTelegram(
    fake.ctx,
    scripted(events),
    projectName,
    caps,
    options
  ).then((result) => ({ ...fake, result }));
};

describe("splitText", () => {
  test("returns the text unchanged when within the limit", () => {
    expect(splitText("hello", 100)).toEqual(["hello"]);
  });

  test("splits oversized text into chunks that each fit, losslessly", () => {
    const text = Array.from({ length: 400 }, (_, i) => `line-${i}`).join("\n");
    const chunks = splitText(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
    expect(chunks.join("")).toBe(text);
  });
});

describe("streamToTelegram", () => {
  test("accumulates text deltas into a persisted message", async () => {
    const { rich, result } = await run([
      { kind: "session_init", sessionId: "s-1" },
      { kind: "text_delta", text: "Hello, " },
      { kind: "text_delta", text: "world!" },
    ]);
    const bodies = rich.map(bodyOf).join("\n");
    expect(bodies).toContain("Hello, world!");
    expect(result.sessionId).toBe("s-1");
  });

  test("an interrupt renders friendly copy, never a raw exit code", async () => {
    const { rich, plain, result } = await run([
      {
        kind: "error",
        message: "Process exited with code 143",
        class: new AgentInterrupted({ reason: "stopped" }),
      },
    ]);
    const all = [...rich.map(bodyOf), ...plain].join("\n");
    expect(all).toContain("Esecuzione interrotta.");
    expect(all).not.toContain("143");
    expect(result.errorClass?._tag).toBe("AgentInterrupted");
  });

  test("thinking UI is gated on the provider capability", async () => {
    const thinkingEvents: AgentEvent[] = [
      { kind: "thinking_start" },
      { kind: "thinking_delta", text: "brainstorm-token" },
      { kind: "thinking_done", durationMs: 10 },
    ];

    const on = await run(thinkingEvents, { ...FULL_CAPS, thinking: true });
    expect(on.rich.map(bodyOf).join("\n")).toContain("brainstorm-token");

    const off = await run(thinkingEvents, { ...FULL_CAPS, thinking: false });
    const offBodies = [...off.rich.map(bodyOf), ...off.drafts.map(bodyOf)].join(
      "\n"
    );
    expect(offBodies).not.toContain("brainstorm-token");
  });

  test("populates the result footer economics from the result event", async () => {
    const { result } = await run([
      { kind: "text_delta", text: "done" },
      {
        kind: "result",
        text: "done",
        sessionId: "s-9",
        cost: 0.02,
        durationMs: 1500,
        turns: 3,
        totalTokens: 900,
      },
    ]);
    expect(result.cost).toBe(0.02);
    expect(result.turns).toBe(3);
    expect(result.totalTokens).toBe(900);
    expect(result.sessionId).toBe("s-9");
  });

  test("retains the exact provider error separately from rendered copy", async () => {
    const exact =
      "Selected model is at capacity. Please try a different model.";
    const { result } = await run([{ kind: "error", message: exact }]);
    expect(result.errorMessage).toBe(exact);
    expect(result.observableWorkStarted).toBe(false);
  });

  test("preserves a raw startup-capacity signal across a terminal wrapper error", async () => {
    const capacity =
      "Selected model is at capacity. Please try a different model.";
    const terminal = "Codex SDK subprocess exited with code 1";
    const { result } = await run([
      { kind: "session_init", sessionId: "failed-session" },
      { kind: "error", message: capacity },
      {
        kind: "error",
        message: terminal,
        class: new ProviderCrashed({ message: terminal }),
      },
    ]);

    expect(result.providerStartupErrorMessage).toBe(capacity);
    expect(result.errorMessage).toBe(terminal);
    expect(result.errorClass?._tag).toBe("ProviderCrashed");
    expect(result.observableWorkStarted).toBe(false);
  });

  test.each([
    { kind: "text_delta", text: "visible" } satisfies AgentEvent,
    { kind: "tool_use", name: "Read", input: "README.md" } satisfies AgentEvent,
    {
      kind: "agent_started",
      taskId: "a-1",
      description: "inspect",
    } satisfies AgentEvent,
    { kind: "plan_ready", planPath: "/tmp/PLAN.md" } satisfies AgentEvent,
    {
      kind: "result",
      text: "final output",
      sessionId: "s-1",
      durationMs: 1,
    } satisfies AgentEvent,
  ])("marks externally observable work for %p", async (event) => {
    const { result } = await run([event]);
    expect(result.observableWorkStarted).toBe(true);
  });

  test("reasoning and session initialization alone are not observable work", async () => {
    const { result } = await run([
      { kind: "session_init", sessionId: "s-1" },
      { kind: "thinking_start" },
      { kind: "thinking_delta", text: "private reasoning" },
      { kind: "thinking_done", durationMs: 1 },
    ]);
    expect(result.observableWorkStarted).toBe(false);
  });

  test("warns without terminating the event stream", async () => {
    const fake = makeFakeCtx();
    let completed = false;
    async function* delayedEvents(): AsyncGenerator<AgentEvent> {
      await Bun.sleep(70);
      yield { kind: "text_delta", text: "still running" };
      await Bun.sleep(70);
      completed = true;
      yield {
        kind: "result",
        text: "done",
        sessionId: "session-1",
        durationMs: 140,
      };
    }

    const result = await streamToTelegram(
      fake.ctx,
      delayedEvents(),
      "proj",
      FULL_CAPS,
      { inactivityWarningMs: 20 }
    );

    expect(completed).toBe(true);
    expect(result.sessionId).toBe("session-1");
    expect(fake.plain).toHaveLength(2);
    expect(fake.plain[0]).toContain("Il lavoro continua");
  });

  test("zero disables stream inactivity warnings", async () => {
    const fake = makeFakeCtx();
    async function* delayedEvents(): AsyncGenerator<AgentEvent> {
      await Bun.sleep(30);
      yield { kind: "text_delta", text: "done" };
    }

    await streamToTelegram(fake.ctx, delayedEvents(), "proj", FULL_CAPS, {
      inactivityWarningMs: 0,
    });

    expect(fake.plain).toEqual([]);
  });

  test("progress diagnostics cannot break provider iteration", async () => {
    const fake = makeFakeCtx();

    const result = await streamToTelegram(
      fake.ctx,
      scripted([
        { kind: "text_delta", text: "work" },
        {
          kind: "result",
          text: "done",
          sessionId: "session-2",
          durationMs: 1,
        },
      ]),
      "proj",
      FULL_CAPS,
      {
        inactivityWarningMs: 20,
        onProgress: () => {
          throw new Error("diagnostic unavailable");
        },
      }
    );

    expect(result.sessionId).toBe("session-2");
  });
});
