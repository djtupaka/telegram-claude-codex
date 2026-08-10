import type { ThreadOptions } from "@openai/codex-sdk";

export interface CodexRuntimeConfig {
  model?: string;
  reasoningEffort?: ThreadOptions["modelReasoningEffort"];
}

const normalized = (value: string | undefined) => {
  const result = value?.trim();
  return result || undefined;
};

export const readCodexRuntimeConfig = (
  env: NodeJS.ProcessEnv = process.env
): CodexRuntimeConfig => ({
  model: normalized(env.CODEX_MODEL),
  reasoningEffort: normalized(env.CODEX_REASONING_EFFORT) as
    | ThreadOptions["modelReasoningEffort"]
    | undefined,
});

export const codexThreadOverrides = (
  env: NodeJS.ProcessEnv = process.env
): Partial<Pick<ThreadOptions, "model" | "modelReasoningEffort">> => {
  const config = readCodexRuntimeConfig(env);
  return {
    ...(config.model ? { model: config.model } : {}),
    ...(config.reasoningEffort
      ? { modelReasoningEffort: config.reasoningEffort }
      : {}),
  };
};

export const formatCodexStatus = (env: NodeJS.ProcessEnv = process.env) => {
  const config = readCodexRuntimeConfig(env);
  return [
    `Modello: ${config.model ?? "ereditato"}`,
    `Effort: ${config.reasoningEffort ?? "ereditato"}`,
  ].join("\n");
};
