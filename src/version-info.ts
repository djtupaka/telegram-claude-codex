import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_PACKAGE_PATH = join(import.meta.dir, "..", "package.json");
const COMMAND_TIMEOUT_MS = 2000;
const COMMAND_KILL_MS = 1750;
const MAX_VERSION_CHARS = 120;
const MAX_COMMAND_OUTPUT_CHARS = 512;
const VERSION_TOKEN =
  "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)" +
  "(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?" +
  "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?";
const PACKAGE_VERSION = new RegExp(`^(${VERSION_TOKEN})$`);
const CODEX_VERSION = new RegExp(`^codex-cli +(${VERSION_TOKEN})$`);
const CLAUDE_VERSION = new RegExp(`^(${VERSION_TOKEN}) +\\(Claude Code\\)$`);
const BUN_VERSION = new RegExp(`^(?:bun +)?v?(${VERSION_TOKEN})$`, "i");
const HAPPY_VERSION = new RegExp(
  `^(?:happy +|Happy CLI Version: +)v?(${VERSION_TOKEN})$`,
  "i"
);
const FORMAT_CHARACTER = /\p{Cf}/u;

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

const hasUnsafeUnicode = (value: string) =>
  Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159);
  }) || FORMAT_CHARACTER.test(value);

const validatedPackageVersion = (value: unknown) => {
  if (typeof value !== "string") {
    return undefined;
  }
  const candidate = value.trim();
  if (
    !candidate ||
    candidate.length > MAX_VERSION_CHARS ||
    hasUnsafeUnicode(candidate)
  ) {
    return undefined;
  }
  return PACKAGE_VERSION.exec(candidate)?.[1];
};

const firstLogicalLine = (value: string | undefined) => {
  if (!value) {
    return undefined;
  }
  const crAt = value.indexOf("\r");
  const lfAt = value.indexOf("\n");
  const boundaries = [crAt, lfAt].filter((index) => index >= 0);
  const boundary =
    boundaries.length > 0 ? Math.min(...boundaries) : value.length;
  const line = value.slice(0, boundary).trim();
  if (!line || line.length > MAX_VERSION_CHARS || hasUnsafeUnicode(line)) {
    return undefined;
  }
  return line;
};

const parseCommandVersion = (
  command: "bun" | "claude" | "codex" | "happy",
  output: string | undefined
) => {
  const line = firstLogicalLine(output);
  if (!line) {
    return undefined;
  }
  if (command === "codex") {
    const version = CODEX_VERSION.exec(line)?.[1];
    return version ? `codex-cli ${version}` : undefined;
  }
  if (command === "claude") {
    const version = CLAUDE_VERSION.exec(line)?.[1];
    return version ? `${version} (Claude Code)` : undefined;
  }
  if (command === "bun") {
    return BUN_VERSION.exec(line)?.[1];
  }
  const version = HAPPY_VERSION.exec(line)?.[1];
  return version ? `Happy CLI Version: ${version}` : undefined;
};

/** Read the bot version from its sole authoritative source. */
export const readBotVersion = (path = DEFAULT_PACKAGE_PATH): string =>
  validatedPackageVersion(readPackageMetadata(path)?.version) ?? "unknown";

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
      if (output.includes("\n") || output.includes("\r")) {
        break;
      }
    }
    return output.slice(0, MAX_COMMAND_OUTPUT_CHARS);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};

export const runVersionCommand: VersionCommandRunner = async (command) => {
  try {
    const proc = Bun.spawn({
      cmd: [command, "--version"],
      detached: true,
      stderr: "ignore",
      stdout: "pipe",
    });
    const failedMarker: unique symbol = Symbol("version-command-failed");
    const completed = Promise.all([
      readBoundedStdout(proc.stdout),
      proc.exited,
    ]).then(
      ([stdout, exitCode]) => (exitCode === 0 ? stdout : undefined),
      () => failedMarker
    );
    const timeoutMarker: unique symbol = Symbol("version-command-timeout");
    let cancelKillTimer: () => void = () => undefined;
    const timeout = new Promise<typeof timeoutMarker>((resolve) => {
      const timer = setTimeout(() => {
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          proc.kill();
        }
        resolve(timeoutMarker);
      }, COMMAND_KILL_MS);
      cancelKillTimer = () => clearTimeout(timer);
    });
    const outcome = await Promise.race([completed, timeout]);
    cancelKillTimer();
    if (typeof outcome === "string" || outcome === undefined) {
      return outcome;
    }
    if (outcome === failedMarker) {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill();
      }
    }
    // SIGKILL was sent before the two-second outer deadline. Awaiting the
    // direct child here reaps it, preventing a zombie or leaked subprocess.
    await proc.exited;
    return undefined;
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
  runCommand: VersionCommandRunner = runVersionCommand,
  packagePath = DEFAULT_PACKAGE_PATH
): Promise<RuntimeVersions> => {
  const metadata = readPackageMetadata(packagePath);
  const dependencies = metadata?.dependencies ?? {};
  const versions: RuntimeVersions = {
    bot: validatedPackageVersion(metadata?.version) ?? "unknown",
  };

  const packageVersions = {
    claudeAgentSdk: validatedPackageVersion(
      dependencies["@anthropic-ai/claude-agent-sdk"]
    ),
    codexSdk: validatedPackageVersion(dependencies["@openai/codex-sdk"]),
    grammy: validatedPackageVersion(dependencies.grammy),
  };
  for (const [key, value] of Object.entries(packageVersions)) {
    if (value) {
      versions[key as keyof typeof packageVersions] = value;
    }
  }

  const commands = ["codex", "claude", "bun", "happy"] as const;
  const outputs = await Promise.all(
    commands.map(async (command) =>
      parseCommandVersion(command, await runBounded(runCommand, command))
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
