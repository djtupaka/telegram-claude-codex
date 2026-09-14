import { describe, expect, test } from "bun:test";
import { Exit, Layer, ManagedRuntime, Option, Queue, Redacted } from "effect";
import { AppConfig } from "../config";
import {
  AgentInterrupted,
  AgentTimedOut,
  AtCapacity,
  classifyOutcome,
  ProcessFailed,
  ProviderCrashed,
} from "./errors";
import {
  getRunSnapshot,
  hasRun,
  noteRunProgress,
  RunRegistry,
  startRun,
  stopRun,
} from "./run-registry";
import type { AgentEvent, EventQueue, ProviderSpec, RunOptions } from "./types";

/**
 * Builds an isolated RunRegistry runtime backed by a literal AppConfig so tests
 * never touch env, the global runtime, or a real provider CLI. `maxConcurrentRuns`
 * sizes the shared semaphore under test.
 */
const makeRuntime = (
  maxConcurrentRuns: number,
  runTimeoutMs: Option.Option<number> = Option.none()
) => {
  const cfg = {
    botToken: Redacted.make("x"),
    allowedUserId: 1,
    allowedChatIds: [],
    groqApiKey: Redacted.make("x"),
    projectsDir: "/tmp",
    anthropicApiKey: Option.none(),
    executorMcpUrl: Option.none(),
    executorApiKey: Option.none(),
    draftIntervalMs: 300,
    splitAt: 4000,
    runTimeoutMs,
    runInactivityWarningMs: 1_200_000,
    maxConcurrentRuns,
    eventLogPath: ".data/events.jsonl",
    claudeSettings: {},
  } satisfies typeof AppConfig.Service;
  const layer = RunRegistry.layer.pipe(
    Layer.provide(Layer.succeed(AppConfig, cfg))
  );
  return ManagedRuntime.make(layer);
};

/**
 * Fake provider whose "CLI" is `/bin/sh -c <script>`. The parser turns every
 * non-blank stdout line into a `text_delta`, so a script that `echo`s then
 * `sleep`s proves the run cleared the semaphore and is actively streaming.
 */
const makeSpec = (script: string): ProviderSpec => ({
  id: "claude",
  kind: "cli",
  command: "/bin/sh",
  buildArgs: () => ["-c", script],
  buildEnv: () => ({}),
  createParser: () =>
    function* (lines: string[]) {
      for (const line of lines) {
        if (line.trim()) {
          yield { kind: "text_delta", text: line } satisfies AgentEvent;
        }
      }
    },
});

const makeHangingSdkSpec = (onAbort?: () => void): ProviderSpec => ({
  id: "codex",
  kind: "sdk",
  async *run(_opts, signal) {
    await new Promise<void>((resolve) => {
      const aborted = () => {
        onAbort?.();
        resolve();
      };
      if (signal.aborted) {
        aborted();
      } else {
        signal.addEventListener("abort", aborted, { once: true });
      }
    });
  },
});

const makeOpts = (userId: number): RunOptions => ({
  chatId: userId,
  runKey: String(userId),
  projectDir: process.cwd(),
  prompt: "",
  runId: `run-${userId}`,
  userId,
});

/** Take one queued event, asserting the producer offered one (not just ended). */
const takeEvent = async (
  rt: ReturnType<typeof makeRuntime>,
  queue: EventQueue
) => {
  const exit = await rt.runPromiseExit(Queue.take(queue));
  if (Exit.isFailure(exit)) {
    throw new Error("queue ended before yielding an event");
  }
  return exit.value;
};

/** Poll a predicate until true or timeout (ms). */
const waitUntil = async (pred: () => Promise<boolean>, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

describe("classifyOutcome — every AgentError tag (adversarial)", () => {
  test("interrupt maps to interrupted for every reason", () => {
    for (const reason of ["stopped", "switched", "new_prompt"] as const) {
      expect(classifyOutcome(new AgentInterrupted({ reason }))).toEqual({
        outcome: "interrupted",
        copy: "Esecuzione interrotta.",
      });
    }
  });

  test("timeout maps to interrupted", () => {
    expect(classifyOutcome(new AgentTimedOut({}))).toEqual({
      outcome: "interrupted",
      copy: "Tempo massimo di esecuzione superato.",
    });
  });

  test("at_capacity", () => {
    expect(classifyOutcome(new AtCapacity({}))).toEqual({
      outcome: "at_capacity",
      copy: "Tutti gli agenti sono occupati. Riprova tra poco.",
    });
  });

  test("process failed: trims stderr, tolerates negative/large codes", () => {
    expect(
      classifyOutcome(new ProcessFailed({ code: 137, stderr: "\n oom \n" }))
    ).toEqual({ outcome: "errored", copy: "oom" });
    // Empty/whitespace stderr falls back to the exit-code sentence.
    expect(
      classifyOutcome(new ProcessFailed({ code: -1, stderr: "" })).copy
    ).toBe("Processo terminato con errore (codice -1).");
    expect(
      classifyOutcome(new ProcessFailed({ code: 0, stderr: "\t  \n" })).copy
    ).toBe("Processo terminato con errore (codice 0).");
  });

  test("provider crashed passes message through verbatim (incl. multiline)", () => {
    const message = "spawn ENOENT\n  at Object.<anonymous>";
    expect(classifyOutcome(new ProviderCrashed({ message }))).toEqual({
      outcome: "errored",
      copy: message,
    });
    expect(classifyOutcome(new ProviderCrashed({ message: "" })).copy).toBe("");
  });
});

describe("RunRegistry.stop on unknown user", () => {
  test("returns false when no run is active (backs stopAgent)", async () => {
    const rt = makeRuntime(4);
    try {
      // stopAgent() in agent/index.ts is `runtime.runSync(stopRun(...))`; this
      // exercises the same registry path without the global runtime.
      const stopped = await rt.runPromise(stopRun("424242", "stopped"));
      expect(stopped).toBe(false);
    } finally {
      await rt.dispose();
    }
  });
});

describe("RunRegistry — subprocess lifecycle (fake sh provider)", () => {
  test("configured timeout aborts a hung SDK provider", async () => {
    const rt = makeRuntime(4, Option.some(80));
    let aborted = false;
    try {
      const queue = await rt.runPromise(
        startRun(
          makeHangingSdkSpec(() => {
            aborted = true;
          }),
          makeOpts(900)
        )
      );
      const terminal = await takeEvent(rt, queue);
      expect(terminal.kind).toBe("error");
      if (terminal.kind === "error") {
        expect(terminal.class?._tag).toBe("AgentTimedOut");
      }
      expect(aborted).toBe(true);
    } finally {
      await rt.dispose();
    }
  });

  test("disabled timeout leaves a hung SDK active until explicit stop", async () => {
    const rt = makeRuntime(4, Option.none());
    try {
      const queue = await rt.runPromise(
        startRun(makeHangingSdkSpec(), makeOpts(899))
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await rt.runPromise(hasRun("899"))).toBe(true);
      const snapshot = await rt.runPromise(getRunSnapshot("899"));
      expect(snapshot).toMatchObject({
        runId: "run-899",
        provider: "codex",
      });
      expect(snapshot?.lastProgressAt).toBe(snapshot?.startedAt);
      if (snapshot) {
        (snapshot as { runId: string }).runId = "caller-mutated";
      }
      expect(await rt.runPromise(getRunSnapshot("899"))).toMatchObject({
        runId: "run-899",
      });

      await rt.runPromise(stopRun("899", "stopped"));
      const terminal = await takeEvent(rt, queue);
      expect(terminal.kind).toBe("error");
      if (terminal.kind === "error") {
        expect(terminal.class?._tag).toBe("AgentInterrupted");
      }
    } finally {
      await rt.dispose();
    }
  });

  test("progress advances only the matching active run", async () => {
    const rt = makeRuntime(4, Option.none());
    try {
      await rt.runPromise(startRun(makeHangingSdkSpec(), makeOpts(899)));
      const before = await rt.runPromise(getRunSnapshot("899"));

      await rt.runPromise(noteRunProgress("899", "wrong-run", 5000));
      expect((await rt.runPromise(getRunSnapshot("899")))?.lastProgressAt).toBe(
        before?.lastProgressAt
      );

      await rt.runPromise(noteRunProgress("899", "run-899", 6000));
      expect((await rt.runPromise(getRunSnapshot("899")))?.lastProgressAt).toBe(
        6000
      );

      await rt.runPromise(stopRun("899", "stopped"));
    } finally {
      await rt.dispose();
    }
  });

  test("enforces RUN_TIMEOUT_MS and clears both fiber and active metadata", async () => {
    const rt = makeRuntime(4, Option.some(80));
    try {
      const queue = await rt.runPromise(
        startRun(makeSpec("sleep 30"), makeOpts(901))
      );

      expect(await rt.runPromise(getRunSnapshot("901"))).toMatchObject({
        runId: "run-901",
        provider: "claude",
      });

      const terminal = await takeEvent(rt, queue);
      expect(terminal.kind).toBe("error");
      if (terminal.kind === "error") {
        expect(terminal.class?._tag).toBe("AgentTimedOut");
        expect(terminal.message).toBe("Tempo massimo di esecuzione superato.");
      }

      expect(
        await waitUntil(
          async () =>
            !(await rt.runPromise(hasRun("901"))) &&
            (await rt.runPromise(getRunSnapshot("901"))) === undefined
        )
      ).toBe(true);
    } finally {
      await rt.dispose();
    }
  });

  test("keeps replacement metadata when the interrupted prior run exits", async () => {
    const rt = makeRuntime(4);
    try {
      const first = makeOpts(902);
      first.runId = "old-run";
      const firstQueue = await rt.runPromise(
        startRun(makeSpec("echo old; sleep 30"), first)
      );
      expect((await takeEvent(rt, firstQueue)).kind).toBe("text_delta");

      const replacement = makeOpts(902);
      replacement.runId = "new-run";
      await rt.runPromise(
        startRun(makeSpec("echo new; sleep 30"), replacement)
      );

      expect(
        await waitUntil(async () => {
          const snapshot = await rt.runPromise(getRunSnapshot("902"));
          return snapshot?.runId === "new-run";
        })
      ).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await rt.runPromise(getRunSnapshot("902"))).toMatchObject({
        runId: "new-run",
        provider: "claude",
      });

      await rt.runPromise(stopRun("902", "stopped"));
    } finally {
      await rt.dispose();
    }
  });

  test("(a) interrupt yields an AgentInterrupted-classified error, not an exit code", async () => {
    const rt = makeRuntime(4);
    try {
      const queue = await rt.runPromise(
        startRun(makeSpec("echo go; sleep 30"), makeOpts(1001))
      );
      // Wait for the stream to actually start (permit acquired, process live).
      expect((await takeEvent(rt, queue)).kind).toBe("text_delta");
      expect(await rt.runPromise(hasRun("1001"))).toBe(true);

      const stopped = await rt.runPromise(stopRun("1001", "stopped"));
      expect(stopped).toBe(true);

      const terminal = await takeEvent(rt, queue);
      expect(terminal.kind).toBe("error");
      if (terminal.kind === "error") {
        expect(terminal.class?._tag).toBe("AgentInterrupted");
        expect(terminal.message).toBe("Esecuzione interrotta.");
      }
      expect(
        await waitUntil(
          async () =>
            (await rt.runPromise(getRunSnapshot("1001"))) === undefined
        )
      ).toBe(true);
    } finally {
      await rt.dispose();
    }
  }, 15_000);

  test("(b) a non-zero exit yields ProcessFailed carrying the code + stderr", async () => {
    const rt = makeRuntime(4);
    try {
      const queue = await rt.runPromise(
        startRun(makeSpec("echo boom 1>&2; exit 7"), makeOpts(1002))
      );
      const terminal = await takeEvent(rt, queue);
      expect(terminal.kind).toBe("error");
      if (terminal.kind === "error") {
        expect(terminal.class?._tag).toBe("ProcessFailed");
        if (terminal.class?._tag === "ProcessFailed") {
          expect(terminal.class.code).toBe(7);
          expect(terminal.class.stderr).toContain("boom");
        }
      }
      expect(
        await waitUntil(
          async () =>
            (await rt.runPromise(getRunSnapshot("1002"))) === undefined
        )
      ).toBe(true);
    } finally {
      await rt.dispose();
    }
  }, 15_000);

  test("(c) hasRun tracks the map lifecycle: false → true → false on natural exit", async () => {
    const rt = makeRuntime(4);
    try {
      expect(await rt.runPromise(hasRun("1003"))).toBe(false);
      await rt.runPromise(
        startRun(makeSpec("echo hi; sleep 0.1"), makeOpts(1003))
      );
      expect(await rt.runPromise(hasRun("1003"))).toBe(true);
      // Fiber completes on natural exit → FiberMap auto-removes the entry.
      const cleared = await waitUntil(
        async () => !(await rt.runPromise(hasRun("1003")))
      );
      expect(cleared).toBe(true);
      expect(await rt.runPromise(getRunSnapshot("1003"))).toBeUndefined();
    } finally {
      await rt.dispose();
    }
  }, 15_000);

  test("(d) two users run concurrently up to MAX_CONCURRENT_RUNS", async () => {
    const rt = makeRuntime(2);
    try {
      const q1 = await rt.runPromise(
        startRun(makeSpec("echo one; sleep 30"), makeOpts(2001))
      );
      const q2 = await rt.runPromise(
        startRun(makeSpec("echo two; sleep 30"), makeOpts(2002))
      );
      // Both stream a first event => both cleared the 2-permit semaphore and
      // are running at the same time.
      expect((await takeEvent(rt, q1)).kind).toBe("text_delta");
      expect((await takeEvent(rt, q2)).kind).toBe("text_delta");
      expect(await rt.runPromise(hasRun("2001"))).toBe(true);
      expect(await rt.runPromise(hasRun("2002"))).toBe(true);

      await rt.runPromise(stopRun("2001", "stopped"));
      await rt.runPromise(stopRun("2002", "stopped"));
    } finally {
      await rt.dispose();
    }
  }, 15_000);

  test("(d') a 3rd run past the cap fails AtCapacity, not by killing an active run", async () => {
    const rt = makeRuntime(1);
    try {
      const q1 = await rt.runPromise(
        startRun(makeSpec("echo hold; sleep 30"), makeOpts(3001))
      );
      // Confirm user 3001 owns the single permit before contending for it.
      expect((await takeEvent(rt, q1)).kind).toBe("text_delta");

      const q2 = await rt.runPromise(
        startRun(makeSpec("echo late; sleep 30"), makeOpts(3002))
      );
      // 3002 waits the bounded window, never gets a permit, ends AtCapacity.
      const terminal = await takeEvent(rt, q2);
      expect(terminal.kind).toBe("error");
      if (terminal.kind === "error") {
        expect(terminal.class?._tag).toBe("AtCapacity");
        expect(terminal.message).toBe(
          "Tutti gli agenti sono occupati. Riprova tra poco."
        );
      }
      // The incumbent run was untouched by the capacity rejection.
      expect(await rt.runPromise(hasRun("3001"))).toBe(true);

      await rt.runPromise(stopRun("3001", "stopped"));
    } finally {
      await rt.dispose();
    }
  }, 15_000);
});

describe("RunRegistry external cancellation", () => {
  test("already aborted input never starts the SDK or replaces an incumbent", async () => {
    const rt = makeRuntime(2);
    let started = false;
    const controller = new AbortController();
    controller.abort();
    try {
      await rt.runPromise(startRun(makeHangingSdkSpec(), makeOpts(7000)));
      const spec: ProviderSpec = {
        id: "codex",
        kind: "sdk",
        async *run() {
          started = true;
          yield { kind: "text_delta", text: "unexpected" };
        },
      };
      const queue = await rt.runPromise(
        startRun(spec, {
          ...makeOpts(7000),
          runId: "cancelled",
          signal: controller.signal,
        })
      );
      const event = await takeEvent(rt, queue);
      expect(event.kind).toBe("error");
      expect(started).toBe(false);
      expect((await rt.runPromise(getRunSnapshot("7000")))?.runId).toBe(
        "run-7000"
      );
    } finally {
      await rt.dispose();
    }
  });

  test("abort during a hanging SDK settles its queue and releases the slot", async () => {
    const rt = makeRuntime(1);
    const controller = new AbortController();
    let sdkAborted = false;
    try {
      const queue = await rt.runPromise(
        startRun(
          makeHangingSdkSpec(() => {
            sdkAborted = true;
          }),
          { ...makeOpts(7001), signal: controller.signal }
        )
      );
      controller.abort();
      expect(
        await waitUntil(async () => !(await rt.runPromise(hasRun("7001"))), 500)
      ).toBe(true);
      const event = await takeEvent(rt, queue);
      expect(event.kind === "error" ? event.class?._tag : "wrong-event").toBe(
        "AgentInterrupted"
      );
      expect(sdkAborted).toBe(true);
      expect(await rt.runPromise(getRunSnapshot("7001"))).toBeUndefined();
      const next = await rt.runPromise(
        startRun(makeSpec("echo available"), makeOpts(7002))
      );
      expect((await takeEvent(rt, next)).kind).toBe("text_delta");
    } finally {
      await rt.dispose();
    }
  });

  test("external cancellation kills CLI children and frees the registry", async () => {
    const rt = makeRuntime(1);
    const controller = new AbortController();
    try {
      const queue = await rt.runPromise(
        startRun(makeSpec("echo live; sleep 30"), {
          ...makeOpts(7003),
          signal: controller.signal,
        })
      );
      expect((await takeEvent(rt, queue)).kind).toBe("text_delta");
      controller.abort();
      expect(
        await waitUntil(
          async () => !(await rt.runPromise(hasRun("7003"))),
          1000
        )
      ).toBe(true);
      const terminal = await takeEvent(rt, queue);
      expect(
        terminal.kind === "error" ? terminal.class?._tag : "wrong-event"
      ).toBe("AgentInterrupted");
    } finally {
      await rt.dispose();
    }
  });
});

test("stale consumer cleanup cannot stop an incumbent; matching cleanup can", async () => {
  const rt = makeRuntime(1);
  let aborted = false;
  try {
    await rt.runPromise(
      startRun(
        makeHangingSdkSpec(() => {
          aborted = true;
        }),
        makeOpts(7010)
      )
    );
    expect(
      await rt.runPromise(stopRun("7010", "stopped", "cancelled-other-run"))
    ).toBe(false);
    expect(await rt.runPromise(hasRun("7010"))).toBe(true);
    expect(aborted).toBe(false);
    expect(await rt.runPromise(stopRun("7010", "stopped", "run-7010"))).toBe(
      true
    );
    expect(
      await waitUntil(async () => !(await rt.runPromise(hasRun("7010"))), 500)
    ).toBe(true);
    expect(aborted).toBe(true);
  } finally {
    await rt.dispose();
  }
});
