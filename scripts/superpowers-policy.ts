import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const POLICY_NAMES = ["using-superpowers", "brainstorming"] as const;
type PolicyName = (typeof POLICY_NAMES)[number];

const REPETITION_RULE =
  "Do not repeat an equivalent command, test, hypothesis, or blocker report without new evidence or a relevant state change. After three materially equivalent failed attempts, stop the current turn, preserve state, and report the blocker and evidence. Do not stop the host application or destroy the session.";
const BACKUP_VERSION = 1;
const BACKUP_PREFIX = "policy-";
const WEAK_ROOT_CAUSE = /(?:skip|omit|bypass)\s+(?:root-cause\s+)?diagnos/i;
const WEAK_COMPLETION =
  /(?:claim|report).{0,40}(?:success|complete).{0,30}without.{0,20}(?:evidence|test|verif)/is;
const HOST_DESTRUCTIVE = /\b(?:restart|kill)\s+(?:the\s+)?host\b/i;

export interface PolicyTexts {
  brainstorming: string;
  usingSuperpowers: string;
}

export interface PolicyViolation {
  code: string;
  file: PolicyName | "policy";
  message: string;
  severity: "error";
}

export interface PolicyFileOperations {
  rename: (source: string, destination: string) => void;
}

export interface PolicyPaths {
  backupRoot?: string;
  canonicalRoot?: string;
  skillRoot?: string;
}

export interface InstallPolicyOptions extends PolicyPaths {
  now?: Date;
  operations?: Partial<PolicyFileOperations>;
}

interface BackupEntry {
  backupFile: string | null;
  installedSha256: string;
  originalExisted: boolean;
  originalSha256: string | null;
}

interface BackupManifest {
  createdAt: string;
  files: Record<PolicyName, BackupEntry>;
  kind: "dev-bot-superpowers-policy-backup";
  version: 1;
}

const defaultCanonicalRoot = resolve(import.meta.dir, "../policy/superpowers");
const defaultSkillRoot = "/home/djtupaka/.codex/skills";
const defaultBackupRoot = "/home/djtupaka/.codex/skill-policy-backups";

const sha256 = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

const keyFor = (name: PolicyName): keyof PolicyTexts =>
  name === "using-superpowers" ? "usingSuperpowers" : "brainstorming";

const resolvePaths = (options: PolicyPaths) => ({
  backupRoot: resolve(options.backupRoot ?? defaultBackupRoot),
  canonicalRoot: resolve(options.canonicalRoot ?? defaultCanonicalRoot),
  skillRoot: resolve(options.skillRoot ?? defaultSkillRoot),
});

const policyPath = (root: string, name: PolicyName) =>
  join(root, name, "SKILL.md");

const backupFileName = (name: PolicyName) => `${name}.SKILL.md`;

const readCanonical = (canonicalRoot: string): PolicyTexts => ({
  brainstorming: readFileSync(
    policyPath(canonicalRoot, "brainstorming"),
    "utf8"
  ),
  usingSuperpowers: readFileSync(
    policyPath(canonicalRoot, "using-superpowers"),
    "utf8"
  ),
});

const requiredPatterns: Record<
  PolicyName,
  readonly { code: string; description: string; pattern: RegExp }[]
> = {
  "using-superpowers": [
    {
      code: "invalid-frontmatter",
      description: "using-superpowers name",
      pattern: /\nname: using-superpowers\n/,
    },
    {
      code: "missing-skill-check",
      description: "applicable skill check before action",
      pattern:
        /(?:check|inspect).{0,40}(?:applicable|available) skills?.{0,40}before.{0,30}(?:response|action)|before the first response or action.{0,80}(?:inspect|read)/is,
    },
    {
      code: "missing-proportionality",
      description: "process scaled to risk",
      pattern: /scale.{0,60}(?:process|workflow|verification).{0,40}risk/is,
    },
    {
      code: "missing-read-only-exemption",
      description: "read-only work without design ceremony",
      pattern:
        /read-only.{0,120}(?:does not require|do not require|without|do not invoke).{0,40}(?:design|ceremony)/is,
    },
    {
      code: "missing-user-precedence",
      description: "user instructions override workflow guidance",
      pattern: /user instructions.{0,100}(?:take precedence|override)/is,
    },
    {
      code: "missing-safety-invariant",
      description: "root-cause diagnosis",
      pattern: /root-cause diagnosis/i,
    },
    {
      code: "missing-safety-invariant",
      description: "risk isolation",
      pattern: /(?:risk isolation|isolation for risky work)/i,
    },
    {
      code: "missing-safety-invariant",
      description: "approval for destructive and scope-expanding action",
      pattern: /approval.{0,60}destructive.{0,60}scope-expanding/is,
    },
    {
      code: "missing-safety-invariant",
      description: "proportional tests and review",
      pattern: /proportional tests.{0,40}review/is,
    },
    {
      code: "missing-safety-invariant",
      description: "fresh evidence before completion",
      pattern: /fresh\s+evidence.{0,50}(?:completion|claim)/is,
    },
  ],
  brainstorming: [
    {
      code: "invalid-frontmatter",
      description: "brainstorming name",
      pattern: /\nname: brainstorming\n/,
    },
    {
      code: "missing-material-trigger",
      description: "material behavior, architecture, workflow, or UI trigger",
      pattern:
        /materially new behavior.{0,40}architecture.{0,40}workflow.{0,40}UI/is,
    },
    {
      code: "missing-narrow-fix-path",
      description: "approved narrow fixes use debugging and TDD directly",
      pattern:
        /narrow fix.{0,100}approved.{0,120}systematic debugging.{0,80}test-driven development/is,
    },
    {
      code: "missing-read-only-exemption",
      description: "read-only work without design ceremony",
      pattern:
        /read-only.{0,120}(?:does not require|do not require|without|do not invoke).{0,40}(?:design|ceremony)/is,
    },
    {
      code: "missing-user-precedence",
      description: "user instructions override workflow guidance",
      pattern: /user instructions.{0,100}(?:take precedence|override)/is,
    },
    {
      code: "missing-safety-invariant",
      description: "root-cause diagnosis",
      pattern: /root-cause diagnosis/i,
    },
    {
      code: "missing-safety-invariant",
      description: "risk isolation",
      pattern: /(?:risk isolation|isolation for risky work)/i,
    },
    {
      code: "missing-safety-invariant",
      description: "approval for destructive and scope-expanding action",
      pattern: /approval.{0,60}destructive.{0,60}scope-expanding/is,
    },
    {
      code: "missing-safety-invariant",
      description: "proportional tests and review",
      pattern: /proportional tests.{0,40}review/is,
    },
    {
      code: "missing-safety-invariant",
      description: "fresh evidence before completion",
      pattern: /fresh\s+evidence.{0,50}(?:completion|claim)/is,
    },
  ],
};

const appendViolation = (
  violations: PolicyViolation[],
  file: PolicyName,
  code: string,
  message: string
) => violations.push({ code, file, message, severity: "error" });

export const validatePolicy = (texts: PolicyTexts): PolicyViolation[] => {
  const violations: PolicyViolation[] = [];

  for (const name of POLICY_NAMES) {
    const text = texts[keyFor(name)];
    for (const required of requiredPatterns[name]) {
      if (!required.pattern.test(text)) {
        appendViolation(
          violations,
          name,
          required.code,
          `Missing required policy clause: ${required.description}`
        );
      }
    }
    if (!text.includes(REPETITION_RULE)) {
      appendViolation(
        violations,
        name,
        "missing-exact-repetition-rule",
        "Missing the exact approved repetition boundary"
      );
    }
    if (WEAK_ROOT_CAUSE.test(text)) {
      appendViolation(
        violations,
        name,
        "weakens-root-cause",
        "Policy permits bypassing root-cause diagnosis"
      );
    }
    if (WEAK_COMPLETION.test(text)) {
      appendViolation(
        violations,
        name,
        "weakens-completion-verification",
        "Policy permits completion claims without fresh verification"
      );
    }
    if (HOST_DESTRUCTIVE.test(text)) {
      appendViolation(
        violations,
        name,
        "host-destructive-loop-handling",
        "Policy permits restarting or killing the host"
      );
    }
  }

  return violations;
};

const atomicWrite = (
  destination: string,
  data: string | Uint8Array,
  operations: PolicyFileOperations,
  mode = 0o600
) => {
  const directory = dirname(destination);
  mkdirSync(directory, { recursive: true });
  const temporary = join(
    directory,
    `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", mode);
    writeFileSync(descriptor, data);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, mode);
    operations.rename(temporary, destination);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    rmSync(temporary, { force: true });
  }
};

const defaultOperations: PolicyFileOperations = { rename: renameSync };

const parseManifest = (backupDir: string): BackupManifest => {
  const raw = readFileSync(join(backupDir, "manifest.json"), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!(parsed && typeof parsed === "object")) {
    throw new Error("Invalid policy backup manifest");
  }
  const manifest = parsed as Partial<BackupManifest>;
  if (
    manifest.kind !== "dev-bot-superpowers-policy-backup" ||
    manifest.version !== BACKUP_VERSION ||
    typeof manifest.createdAt !== "string" ||
    !(manifest.files && typeof manifest.files === "object")
  ) {
    throw new Error("Invalid policy backup manifest");
  }
  for (const name of POLICY_NAMES) {
    const entry = manifest.files[name];
    if (
      !entry ||
      typeof entry.installedSha256 !== "string" ||
      typeof entry.originalExisted !== "boolean" ||
      (entry.backupFile !== null &&
        entry.backupFile !== backupFileName(name)) ||
      (entry.originalSha256 !== null &&
        typeof entry.originalSha256 !== "string") ||
      entry.originalExisted !== (entry.backupFile !== null) ||
      entry.originalExisted !== (entry.originalSha256 !== null)
    ) {
      throw new Error(`Invalid policy backup manifest entry: ${name}`);
    }
  }
  return manifest as BackupManifest;
};

const assertApprovedBackupDir = (backupDir: string, backupRoot: string) => {
  const resolvedBackup = resolve(backupDir);
  if (
    dirname(resolvedBackup) !== resolve(backupRoot) ||
    !basename(resolvedBackup).startsWith(BACKUP_PREFIX)
  ) {
    throw new Error("Restore path is not an approved policy backup directory");
  }
};

const restoreFromManifest = (
  backupDir: string,
  manifest: BackupManifest,
  skillRoot: string,
  operations: PolicyFileOperations
) => {
  const originals = new Map<PolicyName, Uint8Array | null>();
  for (const name of POLICY_NAMES) {
    const entry = manifest.files[name];
    if (!entry.originalExisted) {
      originals.set(name, null);
      continue;
    }
    if (!(entry.backupFile && entry.originalSha256)) {
      throw new Error(`Missing backup metadata for ${name}`);
    }
    const bytes = readFileSync(join(backupDir, entry.backupFile));
    if (sha256(bytes) !== entry.originalSha256) {
      throw new Error(`Backup hash mismatch for ${name}`);
    }
    originals.set(name, bytes);
  }

  for (const name of POLICY_NAMES) {
    const destination = policyPath(skillRoot, name);
    const bytes = originals.get(name);
    if (bytes === null) {
      rmSync(destination, { force: true });
    } else if (bytes) {
      atomicWrite(destination, bytes, operations);
    } else {
      throw new Error(`Missing validated backup for ${name}`);
    }
  }
};

export const installPolicy = (options: InstallPolicyOptions = {}) => {
  const paths = resolvePaths(options);
  const operations: PolicyFileOperations = {
    ...defaultOperations,
    ...options.operations,
  };
  const canonical = readCanonical(paths.canonicalRoot);
  const violations = validatePolicy(canonical);
  if (violations.length > 0) {
    throw new Error(
      `Canonical policy validation failed: ${JSON.stringify(violations)}`
    );
  }

  mkdirSync(paths.backupRoot, { recursive: true, mode: 0o700 });
  chmodSync(paths.backupRoot, 0o700);
  const now = options.now ?? new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const backupDir = join(
    paths.backupRoot,
    `${BACKUP_PREFIX}${stamp}-${randomUUID()}`
  );
  mkdirSync(backupDir, { mode: 0o700 });
  chmodSync(backupDir, 0o700);

  const manifest: BackupManifest = {
    createdAt: now.toISOString(),
    files: {
      brainstorming: {
        backupFile: null,
        installedSha256: sha256(canonical.brainstorming),
        originalExisted: false,
        originalSha256: null,
      },
      "using-superpowers": {
        backupFile: null,
        installedSha256: sha256(canonical.usingSuperpowers),
        originalExisted: false,
        originalSha256: null,
      },
    },
    kind: "dev-bot-superpowers-policy-backup",
    version: BACKUP_VERSION,
  };

  for (const name of POLICY_NAMES) {
    const destination = policyPath(paths.skillRoot, name);
    const entry = manifest.files[name];
    if (existsSync(destination)) {
      const bytes = readFileSync(destination);
      entry.backupFile = backupFileName(name);
      entry.originalExisted = true;
      entry.originalSha256 = sha256(bytes);
      const backupPath = join(backupDir, entry.backupFile);
      writeFileSync(backupPath, bytes, { mode: 0o600 });
      chmodSync(backupPath, 0o600);
    }
  }
  const manifestPath = join(backupDir, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(manifestPath, 0o600);

  try {
    for (const name of POLICY_NAMES) {
      atomicWrite(
        policyPath(paths.skillRoot, name),
        canonical[keyFor(name)],
        operations
      );
    }
    for (const name of POLICY_NAMES) {
      const installed = readFileSync(policyPath(paths.skillRoot, name));
      if (sha256(installed) !== manifest.files[name].installedSha256) {
        throw new Error(`Policy installation verification failed for ${name}`);
      }
    }
  } catch (error) {
    restoreFromManifest(backupDir, manifest, paths.skillRoot, operations);
    throw error;
  }

  return {
    backupDir,
    hashes: Object.fromEntries(
      POLICY_NAMES.map((name) => [name, manifest.files[name].installedSha256])
    ) as Record<PolicyName, string>,
  };
};

export const restorePolicy = (
  backupDir: string,
  options: PolicyPaths & { operations?: Partial<PolicyFileOperations> } = {}
) => {
  const paths = resolvePaths(options);
  const resolvedBackup = resolve(backupDir);
  assertApprovedBackupDir(resolvedBackup, paths.backupRoot);
  const manifest = parseManifest(resolvedBackup);
  const operations = { ...defaultOperations, ...options.operations };
  restoreFromManifest(resolvedBackup, manifest, paths.skillRoot, operations);
  return { backupDir: resolvedBackup };
};

export const checkPolicy = (options: PolicyPaths = {}) => {
  const paths = resolvePaths(options);
  const canonical = readCanonical(paths.canonicalRoot);
  const violations = validatePolicy(canonical);
  const files = Object.fromEntries(
    POLICY_NAMES.map((name) => {
      const expectedSha256 = sha256(canonical[keyFor(name)]);
      const destination = policyPath(paths.skillRoot, name);
      const installedSha256 = existsSync(destination)
        ? sha256(readFileSync(destination))
        : null;
      return [
        name,
        {
          expectedSha256,
          installedSha256,
          matches: installedSha256 === expectedSha256,
        },
      ];
    })
  ) as Record<
    PolicyName,
    { expectedSha256: string; installedSha256: string | null; matches: boolean }
  >;
  return {
    files,
    ok:
      violations.length === 0 &&
      POLICY_NAMES.every((name) => files[name].matches),
    violations,
  };
};

const runCli = () => {
  const [command, argument] = process.argv.slice(2);
  if (command === "check") {
    const result = checkPolicy();
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }
  if (command === "install") {
    console.log(JSON.stringify(installPolicy(), null, 2));
    return;
  }
  if (command === "restore" && argument) {
    console.log(JSON.stringify(restorePolicy(argument), null, 2));
    return;
  }
  throw new Error(
    "Usage: superpowers-policy.ts check | install | restore <backup-dir>"
  );
};

if (import.meta.main) {
  runCli();
}
