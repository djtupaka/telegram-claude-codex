import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
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
const CONTRADICTORY_STOP =
  /\b(?:restart|stop|kill)\s+(?:the\s+)?(?:host(?:\s+application)?|bot|app(?:lication)?|session)\b/i;
const CONTRADICTORY_SESSION_DELETE =
  /\b(?:clear|destroy|delete|reset)\s+(?:the\s+)?session\b/i;
const CONTRADICTORY_SAFETY_SKIP =
  /\b(?:skip|omit|bypass)\s+(?:(?:the|all)\s+)?(?:investigation|diagnosis|root-cause|tests?|testing|verification)\b/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

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
  originalMode?: number | null;
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
    const contradictoryText = text.replace(REPETITION_RULE, "");
    if (
      CONTRADICTORY_STOP.test(contradictoryText) ||
      CONTRADICTORY_SESSION_DELETE.test(contradictoryText)
    ) {
      appendViolation(
        violations,
        name,
        "contradictory-host-or-session-action",
        "Policy contains a host, bot, application, or session destructive instruction"
      );
    }
    if (CONTRADICTORY_SAFETY_SKIP.test(contradictoryText)) {
      appendViolation(
        violations,
        name,
        "contradictory-safety-skip",
        "Policy contains an instruction to skip investigation, testing, or verification"
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

interface TargetState {
  bytes: Uint8Array;
  mode: number;
  sha256: string;
}

const readRegularFile = (
  path: string,
  label: string,
  confinedParent?: string
): TargetState => {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  if (confinedParent) {
    const realParent = realpathSync(confinedParent);
    const realFile = realpathSync(path);
    if (dirname(realFile) !== realParent) {
      throw new Error(`${label} is not confined to its backup directory`);
    }
  }
  const bytes = readFileSync(path);
  return { bytes, mode: metadata.mode % 0o1000, sha256: sha256(bytes) };
};

const parseManifest = (backupDir: string): BackupManifest => {
  const manifestState = readRegularFile(
    join(backupDir, "manifest.json"),
    "Policy backup manifest",
    backupDir
  );
  const parsed: unknown = JSON.parse(
    Buffer.from(manifestState.bytes).toString("utf8")
  );
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
      !SHA256_PATTERN.test(entry.installedSha256) ||
      typeof entry.originalExisted !== "boolean" ||
      (entry.backupFile !== null &&
        entry.backupFile !== backupFileName(name)) ||
      (entry.originalSha256 !== null &&
        (typeof entry.originalSha256 !== "string" ||
          !SHA256_PATTERN.test(entry.originalSha256))) ||
      (entry.originalMode !== undefined &&
        entry.originalMode !== null &&
        (!Number.isInteger(entry.originalMode) ||
          entry.originalMode < 0 ||
          entry.originalMode > 0o777)) ||
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
  const backupMetadata = lstatSync(resolvedBackup);
  if (backupMetadata.isSymbolicLink() || !backupMetadata.isDirectory()) {
    throw new Error("Policy backup must be a non-symlink directory");
  }
  const realBackupRoot = realpathSync(resolve(backupRoot));
  const realBackup = realpathSync(resolvedBackup);
  if (
    dirname(realBackup) !== realBackupRoot ||
    !basename(resolvedBackup).startsWith(BACKUP_PREFIX)
  ) {
    throw new Error("Restore path is not an approved policy backup directory");
  }
};

const readBackupStates = (backupDir: string, manifest: BackupManifest) => {
  const originals = new Map<PolicyName, TargetState | null>();
  for (const name of POLICY_NAMES) {
    const entry = manifest.files[name];
    if (!entry.originalExisted) {
      originals.set(name, null);
      continue;
    }
    if (!(entry.backupFile && entry.originalSha256)) {
      throw new Error(`Missing backup metadata for ${name}`);
    }
    const state = readRegularFile(
      join(backupDir, entry.backupFile),
      `Policy backup entry ${name}`,
      backupDir
    );
    if (state.sha256 !== entry.originalSha256) {
      throw new Error(`Backup hash mismatch for ${name}`);
    }
    originals.set(name, {
      ...state,
      mode: entry.originalMode ?? 0o600,
    });
  }
  return originals;
};

const captureTargetStates = (skillRoot: string) => {
  const states = new Map<PolicyName, TargetState | null>();
  for (const name of POLICY_NAMES) {
    const destination = policyPath(skillRoot, name);
    if (!existsSync(destination)) {
      states.set(name, null);
      continue;
    }
    states.set(name, readRegularFile(destination, `Policy target ${name}`));
  }
  return states;
};

const applyTargetStates = (
  states: Map<PolicyName, TargetState | null>,
  skillRoot: string,
  operations: PolicyFileOperations,
  action: string
) => {
  for (const name of POLICY_NAMES) {
    const destination = policyPath(skillRoot, name);
    const state = states.get(name);
    if (state === null) {
      rmSync(destination, { force: true });
    } else if (state) {
      atomicWrite(destination, state.bytes, operations, state.mode);
    } else {
      throw new Error(`Missing ${action} state for ${name}`);
    }
  }
  for (const name of POLICY_NAMES) {
    const destination = policyPath(skillRoot, name);
    const expected = states.get(name);
    if (expected === null) {
      if (existsSync(destination)) {
        throw new Error(`${action} verification failed for ${name}`);
      }
      continue;
    }
    if (!expected) {
      throw new Error(`Missing ${action} verification state for ${name}`);
    }
    const actual = readRegularFile(destination, `Policy target ${name}`);
    if (actual.sha256 !== expected.sha256 || actual.mode !== expected.mode) {
      throw new Error(`${action} verification failed for ${name}`);
    }
  }
};

const restoreFromManifest = (
  backupDir: string,
  manifest: BackupManifest,
  skillRoot: string,
  operations: PolicyFileOperations
) => {
  applyTargetStates(
    readBackupStates(backupDir, manifest),
    skillRoot,
    operations,
    "Policy restore"
  );
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
        originalMode: null,
        originalSha256: null,
      },
      "using-superpowers": {
        backupFile: null,
        installedSha256: sha256(canonical.usingSuperpowers),
        originalExisted: false,
        originalMode: null,
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
      const original = readRegularFile(destination, `Policy target ${name}`);
      entry.backupFile = backupFileName(name);
      entry.originalExisted = true;
      entry.originalMode = original.mode;
      entry.originalSha256 = original.sha256;
      const backupPath = join(backupDir, entry.backupFile);
      writeFileSync(backupPath, original.bytes, { mode: 0o600 });
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
    try {
      restoreFromManifest(backupDir, manifest, paths.skillRoot, operations);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Policy installation failed and rollback failed"
      );
    }
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
  const desired = readBackupStates(resolvedBackup, manifest);
  const beforeRestore = captureTargetStates(paths.skillRoot);
  try {
    applyTargetStates(desired, paths.skillRoot, operations, "Policy restore");
  } catch (error) {
    try {
      applyTargetStates(
        beforeRestore,
        paths.skillRoot,
        operations,
        "Policy restore rollback"
      );
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Policy restore failed and rollback failed"
      );
    }
    throw error;
  }
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
