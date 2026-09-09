import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  installPolicy,
  type PolicyFileOperations,
  restorePolicy,
  validatePolicy,
} from "./superpowers-policy";

const REPETITION_RULE =
  "Do not repeat an equivalent command, test, hypothesis, or blocker report without new evidence or a relevant state change. After three materially equivalent failed attempts, stop the current turn, preserve state, and report the blocker and evidence. Do not stop the host application or destroy the session.";
const HASH_PATTERN = /hash/i;
const POLICY_BACKUP_PATTERN = /^policy-/;
const VERIFICATION_PATTERN = /verification/i;
const ROLLBACK_PATTERN = /rollback/i;
const BACKUP_LOCATION_PATTERN = /symlink|approved/i;
const BACKUP_ENTRY_PATTERN = /symlink|regular|confined/i;
const MANIFEST_PATTERN = /manifest/i;

const APPROVED_POLICY_FIXTURE = {
  usingSuperpowers: `---
name: using-superpowers
description: Use when starting work or when applicable skills may govern a task
---
# Using Superpowers
Check applicable skills before action. User instructions take precedence over skill guidance. Scale process and proportional verification to risk. Read-only answers and status checks do not require design ceremony. Preserve root-cause diagnosis, risk isolation, approval for destructive or scope-expanding actions, proportional tests, review, and fresh evidence before completion claims.

${REPETITION_RULE}
`,
  brainstorming: `---
name: brainstorming
description: Use when materially new behavior, architecture, workflows, or UI need design decisions
---
# Brainstorming
Use brainstorming for materially new behavior, architecture, workflows, or UI. Read-only answers do not require design ceremony. Narrow fixes with an already approved outcome use systematic debugging and test-driven development directly. User instructions take precedence over skill guidance. Preserve root-cause diagnosis, risk isolation, approval for destructive or scope-expanding actions, proportional tests, review, and fresh evidence before completion claims.

${REPETITION_RULE}
`,
};

let root: string;
let canonicalRoot: string;
let skillRoot: string;
let backupRoot: string;

const writePolicyFiles = (texts = APPROVED_POLICY_FIXTURE) => {
  for (const [directory, text] of [
    ["using-superpowers", texts.usingSuperpowers],
    ["brainstorming", texts.brainstorming],
  ] as const) {
    const dir = join(canonicalRoot, directory);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), text);
  }
};

const writeInstalledFiles = (usingText: string, brainstormingText: string) => {
  for (const [directory, text] of [
    ["using-superpowers", usingText],
    ["brainstorming", brainstormingText],
  ] as const) {
    const dir = join(skillRoot, directory);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), text);
  }
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "superpowers-policy-"));
  canonicalRoot = join(root, "canonical");
  skillRoot = join(root, "skills");
  backupRoot = join(root, "backups");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("validatePolicy", () => {
  test("rejects policy that weakens diagnosis or completion verification", () => {
    const violations = validatePolicy({
      usingSuperpowers: "skip diagnosis and claim success without tests",
      brainstorming: "all changes are trivial",
    });

    expect(violations).toContainEqual(
      expect.objectContaining({ severity: "error" })
    );
  });

  test("accepts proportional process plus the exact three-attempt boundary", () => {
    expect(validatePolicy(APPROVED_POLICY_FIXTURE)).toEqual([]);
  });

  test("accepts the repository-owned canonical policy", () => {
    const policyRoot = join(import.meta.dir, "..", "policy", "superpowers");
    expect(
      validatePolicy({
        brainstorming: readFileSync(
          join(policyRoot, "brainstorming", "SKILL.md"),
          "utf8"
        ),
        usingSuperpowers: readFileSync(
          join(policyRoot, "using-superpowers", "SKILL.md"),
          "utf8"
        ),
      })
    ).toEqual([]);
  });

  test("rejects a paraphrased or host-destructive repetition boundary", () => {
    expect(
      validatePolicy({
        ...APPROVED_POLICY_FIXTURE,
        usingSuperpowers: APPROVED_POLICY_FIXTURE.usingSuperpowers.replace(
          REPETITION_RULE,
          "After three failures, restart the host and clear the session."
        ),
      })
    ).toContainEqual(
      expect.objectContaining({
        code: "missing-exact-repetition-rule",
        severity: "error",
      })
    );
  });

  test.each([
    "After the fourth failure, restart the host application and clear the session.",
    "After the fourth failure, stop the bot and destroy the session.",
    "Skip investigation, tests, and verification; claim complete.",
  ])("rejects appended contradictory instruction: %s", (contradiction) => {
    expect(
      validatePolicy({
        ...APPROVED_POLICY_FIXTURE,
        usingSuperpowers: `${APPROVED_POLICY_FIXTURE.usingSuperpowers}\n${contradiction}\n`,
      })
    ).toContainEqual(expect.objectContaining({ severity: "error" }));
  });
});

describe("policy install and restore", () => {
  test("backs up exact bytes, atomically installs both files, and restores them", () => {
    const oldUsing = "old using bytes\n";
    const oldBrainstorming = "old brainstorming bytes\n";
    writePolicyFiles();
    writeInstalledFiles(oldUsing, oldBrainstorming);

    const result = installPolicy({
      backupRoot,
      canonicalRoot,
      now: new Date("2026-09-09T12:34:56.000Z"),
      skillRoot,
    });

    expect(statSync(result.backupDir).mode % 0o1000).toBe(0o700);
    expect(
      readFileSync(join(result.backupDir, "using-superpowers.SKILL.md"), "utf8")
    ).toBe(oldUsing);
    expect(
      readFileSync(join(result.backupDir, "brainstorming.SKILL.md"), "utf8")
    ).toBe(oldBrainstorming);
    expect(
      readFileSync(join(skillRoot, "using-superpowers", "SKILL.md"), "utf8")
    ).toBe(APPROVED_POLICY_FIXTURE.usingSuperpowers);
    expect(
      readFileSync(join(skillRoot, "brainstorming", "SKILL.md"), "utf8")
    ).toBe(APPROVED_POLICY_FIXTURE.brainstorming);
    expect(
      statSync(join(result.backupDir, "manifest.json")).mode % 0o1000
    ).toBe(0o600);

    restorePolicy(result.backupDir, { backupRoot, skillRoot });

    expect(
      readFileSync(join(skillRoot, "using-superpowers", "SKILL.md"), "utf8")
    ).toBe(oldUsing);
    expect(
      readFileSync(join(skillRoot, "brainstorming", "SKILL.md"), "utf8")
    ).toBe(oldBrainstorming);
  });

  test("rolls both destinations back when the second atomic replacement fails", () => {
    const oldUsing = "old using\n";
    const oldBrainstorming = "old brainstorming\n";
    writePolicyFiles();
    writeInstalledFiles(oldUsing, oldBrainstorming);
    let failed = false;
    const operations: Partial<PolicyFileOperations> = {
      rename: (source, destination) => {
        if (
          !failed &&
          destination.endsWith(join("brainstorming", "SKILL.md"))
        ) {
          failed = true;
          throw new Error("injected second replacement failure");
        }
        renameSync(source, destination);
      },
    };

    expect(() =>
      installPolicy({
        backupRoot,
        canonicalRoot,
        operations,
        skillRoot,
      })
    ).toThrow("injected second replacement failure");

    expect(
      readFileSync(join(skillRoot, "using-superpowers", "SKILL.md"), "utf8")
    ).toBe(oldUsing);
    expect(
      readFileSync(join(skillRoot, "brainstorming", "SKILL.md"), "utf8")
    ).toBe(oldBrainstorming);
  });

  test("verifies installed hashes and rolls back silent corruption", () => {
    const oldUsing = "old using verified\n";
    const oldBrainstorming = "old brainstorming verified\n";
    writePolicyFiles();
    writeInstalledFiles(oldUsing, oldBrainstorming);
    let corrupted = false;
    const operations: Partial<PolicyFileOperations> = {
      rename: (source, destination) => {
        renameSync(source, destination);
        if (
          !corrupted &&
          destination.endsWith(join("brainstorming", "SKILL.md"))
        ) {
          corrupted = true;
          writeFileSync(destination, "silent corruption");
        }
      },
    };

    expect(() =>
      installPolicy({
        backupRoot,
        canonicalRoot,
        operations,
        skillRoot,
      })
    ).toThrow(VERIFICATION_PATTERN);

    expect(
      readFileSync(join(skillRoot, "using-superpowers", "SKILL.md"), "utf8")
    ).toBe(oldUsing);
    expect(
      readFileSync(join(skillRoot, "brainstorming", "SKILL.md"), "utf8")
    ).toBe(oldBrainstorming);
  });

  test("refuses restore from an arbitrary or tampered backup directory", () => {
    const arbitrary = join(root, "arbitrary");
    mkdirSync(arbitrary);
    writeFileSync(join(arbitrary, "manifest.json"), "{}");

    expect(() => restorePolicy(arbitrary, { backupRoot, skillRoot })).toThrow();
    expect(existsSync(join(skillRoot, "using-superpowers", "SKILL.md"))).toBe(
      false
    );

    writePolicyFiles();
    writeInstalledFiles("before one", "before two");
    const result = installPolicy({ backupRoot, canonicalRoot, skillRoot });
    writeFileSync(
      join(result.backupDir, "using-superpowers.SKILL.md"),
      "tampered"
    );

    expect(() =>
      restorePolicy(result.backupDir, { backupRoot, skillRoot })
    ).toThrow(HASH_PATTERN);
    expect(basename(result.backupDir)).toMatch(POLICY_BACKUP_PATTERN);
  });

  test("rejects a backup directory symlink escaping the approved real root", () => {
    writePolicyFiles();
    writeInstalledFiles("old one", "old two");
    const result = installPolicy({ backupRoot, canonicalRoot, skillRoot });
    const external = join(root, "external-backup");
    cpSync(result.backupDir, external, { recursive: true });
    const link = join(backupRoot, "policy-symlink");
    symlinkSync(external, link, "dir");

    expect(() => restorePolicy(link, { backupRoot, skillRoot })).toThrow(
      BACKUP_LOCATION_PATTERN
    );
  });

  test.each([
    "manifest.json",
    "using-superpowers.SKILL.md",
  ])("rejects a symlinked backup entry: %s", (fileName) => {
    writePolicyFiles();
    writeInstalledFiles("old one", "old two");
    const result = installPolicy({ backupRoot, canonicalRoot, skillRoot });
    const entry = join(result.backupDir, fileName);
    const external = join(root, `external-${fileName.replaceAll("/", "-")}`);
    renameSync(entry, external);
    symlinkSync(external, entry, "file");

    expect(() =>
      restorePolicy(result.backupDir, { backupRoot, skillRoot })
    ).toThrow(BACKUP_ENTRY_PATTERN);
  });

  test("rejects traversal in backup-entry metadata before target mutation", () => {
    writePolicyFiles();
    writeInstalledFiles("old one", "old two");
    const result = installPolicy({ backupRoot, canonicalRoot, skillRoot });
    const manifestPath = join(result.backupDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files["using-superpowers"].backupFile = "../external.SKILL.md";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const installedBefore = readFileSync(
      join(skillRoot, "using-superpowers", "SKILL.md"),
      "utf8"
    );

    expect(() =>
      restorePolicy(result.backupDir, { backupRoot, skillRoot })
    ).toThrow(MANIFEST_PATTERN);
    expect(
      readFileSync(join(skillRoot, "using-superpowers", "SKILL.md"), "utf8")
    ).toBe(installedBefore);
  });

  test("restore rolls both targets back with exact bytes and modes when the second replacement fails", () => {
    writePolicyFiles();
    writeInstalledFiles("backup using", "backup brainstorming");
    const result = installPolicy({ backupRoot, canonicalRoot, skillRoot });
    const usingPath = join(skillRoot, "using-superpowers", "SKILL.md");
    const brainstormingPath = join(skillRoot, "brainstorming", "SKILL.md");
    writeFileSync(usingPath, "current using bytes");
    writeFileSync(brainstormingPath, "current brainstorming bytes");
    chmodSync(usingPath, 0o640);
    chmodSync(brainstormingPath, 0o644);
    let failed = false;
    const operations: Partial<PolicyFileOperations> = {
      rename: (source, destination) => {
        if (!failed && destination === brainstormingPath) {
          failed = true;
          throw new Error("injected restore second replacement failure");
        }
        renameSync(source, destination);
      },
    };

    expect(() =>
      restorePolicy(result.backupDir, { backupRoot, operations, skillRoot })
    ).toThrow("injected restore second replacement failure");
    expect(readFileSync(usingPath, "utf8")).toBe("current using bytes");
    expect(readFileSync(brainstormingPath, "utf8")).toBe(
      "current brainstorming bytes"
    );
    expect(lstatSync(usingPath).mode % 0o1000).toBe(0o640);
    expect(lstatSync(brainstormingPath).mode % 0o1000).toBe(0o644);
  });

  test("restore detects silent corruption and rolls both targets back", () => {
    writePolicyFiles();
    writeInstalledFiles("backup using", "backup brainstorming");
    const result = installPolicy({ backupRoot, canonicalRoot, skillRoot });
    const usingPath = join(skillRoot, "using-superpowers", "SKILL.md");
    const brainstormingPath = join(skillRoot, "brainstorming", "SKILL.md");
    writeFileSync(usingPath, "current using");
    writeFileSync(brainstormingPath, "current brainstorming");
    chmodSync(usingPath, 0o640);
    chmodSync(brainstormingPath, 0o644);
    let corrupted = false;
    const operations: Partial<PolicyFileOperations> = {
      rename: (source, destination) => {
        renameSync(source, destination);
        if (!corrupted && destination === brainstormingPath) {
          corrupted = true;
          writeFileSync(destination, "corrupted after rename");
        }
      },
    };

    expect(() =>
      restorePolicy(result.backupDir, { backupRoot, operations, skillRoot })
    ).toThrow(VERIFICATION_PATTERN);
    expect(readFileSync(usingPath, "utf8")).toBe("current using");
    expect(readFileSync(brainstormingPath, "utf8")).toBe(
      "current brainstorming"
    );
    expect(lstatSync(usingPath).mode % 0o1000).toBe(0o640);
    expect(lstatSync(brainstormingPath).mode % 0o1000).toBe(0o644);
  });

  test("restore surfaces a rollback failure", () => {
    writePolicyFiles();
    writeInstalledFiles("backup using", "backup brainstorming");
    const result = installPolicy({ backupRoot, canonicalRoot, skillRoot });
    let calls = 0;
    const operations: Partial<PolicyFileOperations> = {
      rename: (source, destination) => {
        calls += 1;
        if (calls >= 2) {
          throw new Error("injected persistent rename failure");
        }
        renameSync(source, destination);
      },
    };

    expect(() =>
      restorePolicy(result.backupDir, { backupRoot, operations, skillRoot })
    ).toThrow(ROLLBACK_PATTERN);
  });
});
