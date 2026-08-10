import { describe, expect, test } from "bun:test";
import { sanitizeCodexEnv } from "./codex-env";

describe("sanitizeCodexEnv", () => {
  test("keeps runtime variables but removes bot-only credentials", () => {
    const env = sanitizeCodexEnv({
      ALLOWED_USER_ID: "74919235",
      ANTHROPIC_API_KEY: "anthropic-secret",
      BOT_TOKEN: "telegram-secret",
      CLAUDECODE: "1",
      EXECUTOR_API_KEY: "executor-secret",
      GROQ_API_KEY: "groq-secret",
      HOME: "/home/test",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=secret",
      PATH: "/usr/bin",
      TELEGRAM_CHAT_ID: "74919235",
      UNDEFINED_VALUE: undefined,
    });

    expect(env).toEqual({ HOME: "/home/test", PATH: "/usr/bin" });
    expect(JSON.stringify(env)).not.toContain("secret");
  });
});
