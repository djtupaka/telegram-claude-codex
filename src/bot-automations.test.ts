import { expect, spyOn, test } from "bun:test";
import type { Bot, Context } from "grammy";
import { installAutomations, parseProgramCommand } from "./bot-automations";

test("Italian program parsing accepts daily and ISO while preserving prompt", () => {
  expect(parseProgramCommand("giornaliero 09:00 Controlla backup")).toEqual({
    schedule: { kind: "daily", time: "09:00", timezone: "Europe/Rome" },
    prompt: "Controlla backup",
  });
  expect(
    parseProgramCommand("una 2026-12-01T09:00:00+01:00 Analizza i log")
  ).toEqual({
    schedule: { kind: "once", at: "2026-12-01T09:00:00+01:00" },
    prompt: "Analizza i log",
  });
  expect(() => parseProgramCommand("giornaliero 25:00 test")).toThrow();
  expect(() => parseProgramCommand("giornaliero 09:00")).toThrow();
});
test("installation registers commands without starting listener and scopes cancellation", async () => {
  const handlers = new Map<string, (ctx: Context) => Promise<void>>();
  const replies: string[] = [];
  const cancelled: string[] = [];
  const bot = {
    command: (name: string, fn: (ctx: Context) => Promise<void>) =>
      handlers.set(name, fn),
    api: {
      sendMessage: async () => {
        /* No side effects in this adapter. */
      },
    },
  } as unknown as Bot;
  const target = {
    scopeKey: "t:-1:2",
    chatId: -1,
    threadId: 2,
    project: "/tmp",
    provider: "codex" as const,
  };
  const store = {
    list: () => [],
    cancel: (scope: string, id: string) => {
      cancelled.push(scope, id);
      return true;
    },
    onCancel: () => () => {
      /* No side effects in this adapter. */
    },
    subscriptions: () => [],
  };
  const lifecycle = installAutomations({
    bot,
    store: store as never,
    validateTarget: () => {
      /* Authorized test target. */
    },
    getTarget: () => target,
    run: async () => {
      /* No side effects in this adapter. */
    },
    isBusy: () => false,
  });
  expect(handlers.size).toBe(4);
  await handlers.get("annulla_programma")?.({
    match: "job-1",
    reply: async (text: string) => {
      replies.push(text);
    },
  } as unknown as Context);
  expect(cancelled).toEqual(["t:-1:2", "job-1"]);
  expect(replies[0]).toContain("annullato");
  lifecycle.stop();
});
test("explicit listener configuration requires a strong token before starting anything", () => {
  const bot = {
    command: () => {
      /* No side effects in this adapter. */
    },
  } as unknown as Bot;
  expect(() =>
    installAutomations({
      bot,
      validateTarget: () => {
        /* Authorized test target. */
      },
      getTarget: () => {
        throw new Error("unused");
      },
      run: async () => {
        /* No side effects in this adapter. */
      },
      isBusy: () => false,
      eventsPort: 12_345,
      eventsToken: "weak",
    })
  ).toThrow("32");
});

test("event adapter enforces read-only Claude and notification-only Codex without opening a socket", async () => {
  let fetch: ((request: Request) => Promise<Response>) | undefined;
  let stopped = false;
  let revoked = false;
  const serve = spyOn(Bun, "serve").mockImplementation((config) => {
    expect(config.hostname).toBe("127.0.0.1");
    fetch = (
      config as unknown as { fetch: (request: Request) => Promise<Response> }
    ).fetch;
    return {
      stop: () => {
        stopped = true;
      },
    } as unknown as ReturnType<typeof Bun.serve>;
  });
  const notifications: string[] = [];
  const runs: boolean[] = [];
  let provider: "claude" | "codex" = "claude";
  const target = () => ({
    scopeKey: "t:-1:2",
    chatId: -1,
    threadId: 2,
    project: "/tmp",
    provider,
  });
  const store = {
    list: () => [],
    onCancel: () => () => {
      /* no listener */
    },
    subscriptions: () => [{ ...target(), source: "coolify" }],
  };
  const bot = {
    command: () => {
      /* registration only */
    },
    api: {
      sendMessage: async (_chat: number, text: string) => {
        notifications.push(text);
      },
    },
  } as unknown as Bot;
  const life = installAutomations({
    bot,
    store: store as never,
    validateTarget: () => {
      if (revoked) {
        throw new Error("Destinazione revocata");
      }
    },
    getTarget: target,
    isBusy: () => false,
    run: async (_target, _prompt, _signal, readOnly) => {
      runs.push(readOnly);
    },
    eventsPort: 12_345,
    eventsToken: "x".repeat(32),
  });
  try {
    expect(serve).not.toHaveBeenCalled();
    life.start();
    for (const id of ["one", "two", "revoked"]) {
      const response = await fetch?.(
        new Request("http://localhost/events", {
          method: "POST",
          headers: {
            authorization: `Bearer ${"x".repeat(32)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            id,
            source: "coolify",
            title: "Failure",
            message: "External payload",
          }),
        })
      );
      expect(response?.status).toBe(202);
      await Bun.sleep(2);
      provider = "codex";
      if (id === "two") {
        revoked = true;
      }
    }
    expect(runs).toEqual([true]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("non avviata per Codex");
  } finally {
    life.stop();
    serve.mockRestore();
  }
  expect(stopped).toBe(true);
});
