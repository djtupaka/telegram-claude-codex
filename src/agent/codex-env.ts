const BOT_ONLY_ENV = new Set([
  "ALLOWED_USER_ID",
  "ANTHROPIC_API_KEY",
  "BOT_TOKEN",
  "CLAUDECODE",
  "EXECUTOR_API_KEY",
  "GROQ_API_KEY",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "TELEGRAM_CHAT_ID",
]);

/** Keep the runtime environment Codex needs without forwarding bot credentials. */
export const sanitizeCodexEnv = (
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !BOT_ONLY_ENV.has(entry[0])
    )
  );
