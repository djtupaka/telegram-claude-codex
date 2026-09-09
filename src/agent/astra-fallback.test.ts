import { describe, expect, test } from "bun:test";
import {
  runWithAstraStartupFallback,
  shouldFallbackToSol,
} from "./astra-fallback";
import { AtCapacity } from "./errors";

const eligible = {
  provider: "codex" as const,
  model: "gpt-6-astra",
  errorMessage: "Selected model is at capacity. Please try a different model.",
  observableWorkStarted: false,
  resumedSession: false,
  fallbackAttempted: false,
};

describe("shouldFallbackToSol", () => {
  test("allows one Sol fallback for an Astra capacity failure before work", () => {
    expect(shouldFallbackToSol(eligible)).toBe(true);
  });

  test.each([
    { observableWorkStarted: true },
    { resumedSession: true },
    { fallbackAttempted: true },
  ])("never replays partial work or retries twice", (flags) => {
    expect(shouldFallbackToSol({ ...eligible, ...flags })).toBe(false);
  });

  test.each([
    { provider: "claude" as const },
    { model: "gpt-5.6-sol" },
    { errorMessage: "Provider request failed" },
    { errorMessage: "Telegram API is unavailable" },
    { errorMessage: "AtCapacity" },
    { errorMessage: "" },
  ])("fails closed for an ineligible failure", (override) => {
    expect(shouldFallbackToSol({ ...eligible, ...override })).toBe(false);
  });

  test("accepts the provider's model-unavailable startup wording", () => {
    expect(
      shouldFallbackToSol({
        ...eligible,
        errorMessage: "The selected model is temporarily unavailable.",
      })
    ).toBe(true);
  });

  test("rejects the bot's local concurrency AtCapacity error", () => {
    expect(
      shouldFallbackToSol({
        ...eligible,
        errorClass: new AtCapacity({}),
      })
    ).toBe(false);
  });
});

describe("runWithAstraStartupFallback", () => {
  test("executes Astra then Sol once and announces before the retry", async () => {
    const calls: string[] = [];
    const result = await runWithAstraStartupFallback({
      provider: "codex",
      model: "gpt-6-astra",
      resumedSession: false,
      runIds: ["astra-run", "sol-run"],
      executeAttempt: async (attempt) => {
        calls.push(`execute:${attempt.model}:${attempt.runId}`);
        return attempt.fallbackAttempted
          ? { value: "sol-ok", observableWorkStarted: true }
          : {
              value: "astra-failed",
              errorMessage: "Selected model is at capacity.",
              observableWorkStarted: false,
            };
      },
      beforeFallback: async () => {
        calls.push("before-fallback");
      },
    });

    expect(result.value).toBe("sol-ok");
    expect(calls).toEqual([
      "execute:gpt-6-astra:astra-run",
      "before-fallback",
      "execute:gpt-5.6-sol:sol-run",
    ]);
  });

  test("does not request a second generator after observable work", async () => {
    let attempts = 0;
    const result = await runWithAstraStartupFallback({
      provider: "codex",
      model: "gpt-6-astra",
      resumedSession: false,
      runIds: ["astra-run", "unused-sol-run"],
      executeAttempt: async () => {
        attempts += 1;
        return {
          value: "partial",
          errorMessage: "Selected model is at capacity.",
          observableWorkStarted: true,
        };
      },
      beforeFallback: async () => {
        throw new Error("must not announce");
      },
    });

    expect(result.value).toBe("partial");
    expect(attempts).toBe(1);
  });

  test("never retries a resumed session", async () => {
    let attempts = 0;
    await runWithAstraStartupFallback({
      provider: "codex",
      model: "gpt-6-astra",
      resumedSession: true,
      runIds: ["astra-run", "unused-sol-run"],
      executeAttempt: async () => {
        attempts += 1;
        return {
          errorMessage: "Selected model is at capacity.",
          observableWorkStarted: false,
        };
      },
      beforeFallback: async () => {
        throw new Error("must not announce");
      },
    });
    expect(attempts).toBe(1);
  });
});
