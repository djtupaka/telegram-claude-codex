import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { storeAttachment } from "./attachments";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((p) => rm(p, { recursive: true, force: true }))
  );
});
const temporary = async () => {
  const p = await mkdtemp(join(tmpdir(), "attachments-"));
  directories.push(p);
  return p;
};
const input = (projectPath: string) => ({
  rootDir: join(projectPath, "archive"),
  projectPath,
  scopeKey: "t:-100123:45",
  originalName: "../../Pompa acqua.pdf",
  mimeType: "application/pdf",
  telegramFileId: "telegram-file",
  telegramFileUniqueId: "unique-file",
  data: new TextEncoder().encode("original bytes"),
  receivedAt: new Date("2026-09-14T12:00:00Z"),
});

test("preserves original bytes and persists provenance beside a safe dated path", async () => {
  const project = await temporary();
  const record = await storeAttachment(input(project));
  expect(relative(project, record.path).startsWith("archive/")).toBe(true);
  expect(record.path).toContain("/2026-09-14/");
  expect(basename(record.path)).not.toContain("..");
  expect(await readFile(record.path, "utf8")).toBe("original bytes");
  expect(record.originalName).toBe("../../Pompa acqua.pdf");
  expect(record.sha256).toBe(
    createHash("sha256").update("original bytes").digest("hex")
  );
  expect(
    JSON.parse(await readFile(`${record.path}.metadata.json`, "utf8"))
  ).toEqual(record);
  expect((await stat(record.path)).mode % 0o1000).toBe(0o600);
});

test("concurrent equal filenames are unique and scopes stay separate", async () => {
  const project = await temporary();
  const records = await Promise.all(
    Array.from({ length: 4 }, () => storeAttachment(input(project)))
  );
  expect(new Set(records.map((r) => r.path)).size).toBe(4);
  const other = await storeAttachment({
    ...input(project),
    scopeKey: "t/-100123/45",
  });
  expect(relative(project, other.path).split("/")[2]).not.toBe(
    relative(project, records[0]?.path ?? "").split("/")[2]
  );
});

test("refuses a symlink upload directory without writing outside the project", async () => {
  const project = await temporary();
  const outside = await temporary();
  await symlink(outside, join(project, "archive"));
  await expect(storeAttachment(input(project))).rejects.toThrow("simbolico");
});
