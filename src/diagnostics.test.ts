import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDiagnostics, formatDiagnostics } from "./diagnostics";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});
async function temporary() {
  const path = await mkdtemp(join(tmpdir(), "diagnostics-"));
  directories.push(path);
  return path;
}
const configured = {
  BOT_TOKEN: `123456:${"a".repeat(35)}`,
  ALLOWED_USER_ID: "123456",
  GROQ_API_KEY: "",
};
const available = { probeCommand: async () => true };

test("missing Telegram configuration blocks while empty Groq disables transcription", async () => {
  const path = await temporary();
  const report = await collectDiagnostics(
    {
      projectsDir: path,
      dataDir: join(path, "data"),
      env: { GROQ_API_KEY: "" },
    },
    available
  );
  expect(report.hasBlockers).toBe(true);
  expect(
    report.checks.find((check) => check.id === "telegram-token")?.status
  ).toBe("error");
  expect(report.checks.find((check) => check.id === "groq")?.status).toBe(
    "info"
  );
  expect(formatDiagnostics(report)).toContain("disabilitata");
  expect(await readdir(path)).toEqual([]);
});

test("missing Groq variable explains the empty value required by runtime", async () => {
  const path = await temporary();
  const report = await collectDiagnostics(
    {
      projectsDir: path,
      dataDir: path,
      env: { ...configured, GROQ_API_KEY: undefined },
    },
    available
  );
  expect(report.checks.find((check) => check.id === "groq")?.status).toBe(
    "error"
  );
  expect(report.hasBlockers).toBe(true);
  expect(formatDiagnostics(report)).toContain('GROQ_API_KEY=""');
});

test("reports writable future storage and CLI presence without claiming authenticated", async () => {
  const path = await temporary();
  const report = await collectDiagnostics(
    { projectsDir: path, dataDir: join(path, "data"), env: configured },
    available
  );
  expect(report.hasBlockers).toBe(false);
  expect(formatDiagnostics(report)).toContain("Autenticazione non verificata");
  expect(report.checks.find((check) => check.id === "disk-data")?.status).toBe(
    "ok"
  );
  expect(await readdir(path)).toEqual([]);
});

test("malformed config and command errors never disclose secret values or stderr", async () => {
  const path = await temporary();
  const secret = "private-secret-do-not-print";
  const report = await collectDiagnostics(
    {
      projectsDir: path,
      dataDir: path,
      env: {
        BOT_TOKEN: secret,
        ALLOWED_USER_ID: "12oops",
        GROQ_API_KEY: secret,
      },
    },
    {
      probeCommand: () => Promise.reject(new Error(secret)),
    }
  );
  expect(report.hasBlockers).toBe(true);
  expect(JSON.stringify(report)).not.toContain(secret);
  expect(formatDiagnostics(report)).not.toContain(secret);
  expect(
    report.checks.find((check) => check.id === "telegram-user")?.status
  ).toBe("error");
});

test("missing project and storage file are blockers; upload fallback is inspected", async () => {
  const path = await temporary();
  const file = join(path, "file");
  await writeFile(file, "unchanged");
  const report = await collectDiagnostics(
    {
      projectsDir: join(path, "missing"),
      dataDir: path,
      env: { ...configured, ATTACHMENTS_DIR: "  ", UPLOADS_DIR: file },
    },
    available
  );
  expect(report.checks.find((check) => check.id === "projects")?.status).toBe(
    "error"
  );
  expect(
    report.checks.find((check) => check.id === "attachments")?.status
  ).toBe("error");
  expect(report.hasBlockers).toBe(true);
});

test("group identifiers must be negative safe integers", async () => {
  const path = await temporary();
  for (const value of ["123", "0", "-9007199254740992", "-12oops"]) {
    const report = await collectDiagnostics(
      {
        projectsDir: path,
        dataDir: path,
        env: { ...configured, ALLOWED_CHAT_IDS: value },
      },
      available
    );
    expect(
      report.checks.find((check) => check.id === "telegram-chats")?.status
    ).toBe("error");
  }
  const report = await collectDiagnostics(
    {
      projectsDir: path,
      dataDir: path,
      env: { ...configured, ALLOWED_CHAT_IDS: "-100123,-100456" },
    },
    available
  );
  expect(
    report.checks.find((check) => check.id === "telegram-chats")?.status
  ).toBe("ok");
});
