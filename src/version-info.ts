import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_PACKAGE_PATH = join(import.meta.dir, "..", "package.json");
const COMMAND_TIMEOUT_MS = 2000;
const MAX_VERSION_CHARS = 120;
const MAX_COMMAND_OUTPUT_CHARS = 512;

interface PackageMetadata {
  dependencies?: Record<string, unknown>;
  version?: unknown;
}

export interface RuntimeVersions {
  bot: string;
  bun?: string;
  claudeAgentSdk?: string;
  claudeCli?: string;
  codexCli?: string;
  codexSdk?: string;
  grammy?: string;
  happy?: string;
}

export type VersionCommandRunner = (
  command: string
) => Promise<string | undefined>;

const readPackageMetadata = (path: string): PackageMetadata | undefined => {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as PackageMetadata)
      : undefined;
  } catch {
    return undefined;
  }
};

const stringValue = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const sanitizeVersion = (value: string | undefined) => {
  if (!value) {
    return undefined;
  }
  const newlineAt = value.indexOf("\n");
  const firstLine = newlineAt === -1 ? value : value.slice(0, newlineAt);
  const sanitized = Array.from(firstLine, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  })
    .join("")
    .trim()
    .slice(0, MAX_VERSION_CHARS);
  return sanitized || undefined;
};

/** Read the bot version from its sole authoritative source. */
export const readBotVersion = (path = DEFAULT_PACKAGE_PATH): string =>
  sanitizeVersion(stringValue(readPackageMetadata(path)?.version)) ?? "unknown";

/** App version stamped onto lifecycle and run events. */
export const BOT_VERSION = readBotVersion();

const readBoundedStdout = async (stdout: ReadableStream<Uint8Array>) => {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (output.length < MAX_COMMAND_OUTPUT_CHARS) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      output += decoder.decode(chunk.value, { stream: true });
      if (output.includes("\n")) {
        break;
      }
    }
    return output.slice(0, MAX_COMMAND_OUTPUT_CHARS);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};

const defaultRunCommand: VersionCommandRunner = async (command) => {
  try {
    const proc = Bun.spawn({
      cmd: [command, "--version"],
      detached: true,
      stderr: "ignore",
      stdout: "pipe",
    });
    const completed = Promise.all([
      readBoundedStdout(proc.stdout),
      proc.exited,
    ]).then(([stdout, exitCode]) => (exitCode === 0 ? stdout : undefined));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill();
      }
    }, COMMAND_TIMEOUT_MS - 100);
    let cancelDeadline: () => void = () => undefined;
    try {
      return await Promise.race([
        completed,
        new Promise<undefined>((resolve) => {
          const deadline = setTimeout(
            () => resolve(undefined),
            COMMAND_TIMEOUT_MS
          );
          cancelDeadline = () => clearTimeout(deadline);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      cancelDeadline();
      if (timedOut) {
        proc.unref();
      }
    }
  } catch {
    return undefined;
  }
};

const runBounded = async (
  runner: VersionCommandRunner,
  command: string
): Promise<string | undefined> => {
  let cancelTimer: () => void = () => undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => runner(command))
        .catch(() => undefined),
      new Promise<undefined>((resolve) => {
        const timer = setTimeout(resolve, COMMAND_TIMEOUT_MS);
        cancelTimer = () => clearTimeout(timer);
      }),
    ]);
  } finally {
    cancelTimer();
  }
};

/** Collect bounded, one-line runtime diagnostics without exposing stderr. */
export const collectRuntimeVersions = async (
  runCommand: VersionCommandRunner = defaultRunCommand,
  packagePath = DEFAULT_PACKAGE_PATH
): Promise<RuntimeVersions> => {
  const metadata = readPackageMetadata(packagePath);
  const dependencies = metadata?.dependencies ?? {};
  const versions: RuntimeVersions = {
    bot: sanitizeVersion(stringValue(metadata?.version)) ?? "unknown",
  };

  const packageVersions = {
    claudeAgentSdk: sanitizeVersion(
      stringValue(dependencies["@anthropic-ai/claude-agent-sdk"])
    ),
    codexSdk: sanitizeVersion(stringValue(dependencies["@openai/codex-sdk"])),
    grammy: sanitizeVersion(stringValue(dependencies.grammy)),
  };
  for (const [key, value] of Object.entries(packageVersions)) {
    if (value) {
      versions[key as keyof typeof packageVersions] = value;
    }
  }

  const commands = ["codex", "claude", "bun", "happy"] as const;
  const outputs = await Promise.all(
    commands.map(async (command) =>
      sanitizeVersion(await runBounded(runCommand, command))
    )
  );
  const keys = ["codexCli", "claudeCli", "bun", "happy"] as const;
  for (const [index, key] of keys.entries()) {
    const output = outputs[index];
    if (output) {
      versions[key] = output;
    }
  }

  return versions;
};
