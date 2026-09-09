import type { AgentError } from "./errors";
import type { ProviderId } from "./types";

const ASTRA_MODEL = "gpt-6-astra";
export const SOL_MODEL = "gpt-5.6-sol";
const START_FAILURE =
  /selected model.*(?:capacity|unavailable)|model.*not available/i;

export interface FallbackInput {
  errorClass?: AgentError;
  errorMessage?: string;
  fallbackAttempted: boolean;
  model: string;
  observableWorkStarted: boolean;
  provider: ProviderId;
  resumedSession: boolean;
}

/**
 * Fail-closed decision for the only automatic model fallback the bot permits.
 * Generic failures, resumed work and any run that already surfaced work remain
 * with their original outcome so a user prompt can never be replayed unsafely.
 */
export const shouldFallbackToSol = (input: FallbackInput) =>
  input.provider === "codex" &&
  input.model === ASTRA_MODEL &&
  !input.errorClass &&
  !input.observableWorkStarted &&
  !input.resumedSession &&
  !input.fallbackAttempted &&
  START_FAILURE.test(input.errorMessage ?? "");

export interface StartupAttempt {
  fallbackAttempted: boolean;
  model: string;
  runId: string;
}

interface StartupResult {
  errorClass?: AgentError;
  errorMessage?: string;
  observableWorkStarted?: boolean;
}

interface StartupFallbackOptions<T extends StartupResult> {
  beforeFallback: (failed: T) => Promise<void>;
  executeAttempt: (attempt: StartupAttempt) => Promise<T>;
  model: string;
  provider: ProviderId;
  resumedSession: boolean;
  /** Exactly two precomputed ids keep the attempt collection statically bounded. */
  runIds: readonly [string, string];
}

/** Execute a primary run and, only when eligible, one statically bounded Sol retry. */
export const runWithAstraStartupFallback = async <T extends StartupResult>(
  options: StartupFallbackOptions<T>
): Promise<T> => {
  const attempts: readonly [StartupAttempt, StartupAttempt] = [
    {
      fallbackAttempted: false,
      model: options.model,
      runId: options.runIds[0],
    },
    {
      fallbackAttempted: true,
      model: SOL_MODEL,
      runId: options.runIds[1],
    },
  ];

  for (const attempt of attempts) {
    const result = await options.executeAttempt(attempt);
    const retry = shouldFallbackToSol({
      provider: options.provider,
      model: attempt.model,
      errorMessage: result.errorMessage,
      errorClass: result.errorClass,
      observableWorkStarted: result.observableWorkStarted ?? false,
      resumedSession: options.resumedSession,
      fallbackAttempted: attempt.fallbackAttempted,
    });
    if (!retry) {
      return result;
    }
    await options.beforeFallback(result);
  }

  // The second attempt always returns because fallbackAttempted is true.
  throw new Error("unreachable bounded fallback state");
};
