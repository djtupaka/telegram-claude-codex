import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  purgeAttachment,
  scanAttachments,
  setAttachmentArchived,
} from "./attachment-manager";
import { storeAttachment } from "./attachments";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((p) => rm(p, { recursive: true, force: true }))
  );
});
async function fixture() {
  const projectPath = await mkdtemp(join(tmpdir(), "manager-"));
  dirs.push(projectPath);
  const options = { projectPath, rootDir: join(projectPath, "archive") };
  const record = await storeAttachment({
    ...options,
    scopeKey: "private",
    data: new TextEncoder().encode("hello"),
    originalName: "Pompa.pdf",
    mimeType: "application/pdf",
    telegramFileId: "x",
  });
  return { ...options, record };
}
test("lists only requested project, searches names and reports bytes", async () => {
  const f = await fixture();
  const other = await fixture();
  await storeAttachment({
    ...f,
    projectPath: other.projectPath,
    scopeKey: "topic",
    data: new Uint8Array([1]),
    originalName: "other.pdf",
    mimeType: "application/pdf",
    telegramFileId: "y",
  });
  const result = await scanAttachments(f);
  expect(result.entries.length).toBe(1);
  expect(result.bytes).toBe(5);
  expect(
    (await scanAttachments({ ...f, search: "POMPA" })).entries.length
  ).toBe(1);
  expect(
    (await scanAttachments({ ...f, search: "missing" })).entries.length
  ).toBe(0);
});
test("archive and restore preserve original bytes and canonical paths", async () => {
  const f = await fixture();
  const entry = (await scanAttachments(f)).entries[0];
  if (!entry) {
    throw new Error("Missing fixture");
  }
  await setAttachmentArchived(f, entry, true);
  const archived = (await scanAttachments(f)).entries[0];
  if (!archived) {
    throw new Error("Missing archived fixture");
  }
  expect(archived.archived).toBe(true);
  expect(await readFile(f.record.path, "utf8")).toBe("hello");
  await setAttachmentArchived(f, archived, false);
  expect((await scanAttachments(f)).entries[0]?.archived).toBe(false);
});
test("rejects stale previews and changed payloads", async () => {
  const f = await fixture();
  const entry = (await scanAttachments(f)).entries[0];
  if (!entry) {
    throw new Error("Missing fixture");
  }
  await writeFile(f.record.path, "world");
  await expect(setAttachmentArchived(f, entry, true)).rejects.toThrow();
});
test("malicious paths, malformed manifests and symlinks are skipped", async () => {
  const f = await fixture();
  const manifest = `${f.record.path}.metadata.json`;
  await writeFile(
    manifest,
    JSON.stringify({ ...f.record, path: "/etc/passwd" })
  );
  expect((await scanAttachments(f)).skipped).toBe(1);
  await writeFile(manifest, "{");
  expect((await scanAttachments(f)).skipped).toBe(1);
  await rm(manifest);
  await symlink("/etc/passwd", manifest);
  expect((await scanAttachments(f)).entries.length).toBe(0);
});

test("purge deletes an active original and metadata without a backup", async () => {
  const f = await fixture();
  const entry = (await scanAttachments(f)).entries[0];
  if (!entry) {
    throw new Error("Missing fixture");
  }
  const result = await purgeAttachment(f, entry);
  expect(result.bytes).toBe(5);
  await expect(readFile(f.record.path)).rejects.toThrow();
  await expect(readFile(`${f.record.path}.metadata.json`)).rejects.toThrow();
  expect((await scanAttachments(f)).entries).toHaveLength(0);
});
test("purge rejects changed files and deletes archived markers only after validation", async () => {
  const f = await fixture();
  const entry = (await scanAttachments(f)).entries[0];
  if (!entry) {
    throw new Error("Missing fixture");
  }
  await setAttachmentArchived(f, entry, true);
  await expect(purgeAttachment(f, entry)).rejects.toThrow();
  expect(await readFile(f.record.path, "utf8")).toBe("hello");
  const archived = (await scanAttachments(f)).entries[0];
  if (!archived) {
    throw new Error("Missing fixture");
  }
  await purgeAttachment(f, archived);
  await expect(readFile(`${f.record.path}.archived.json`)).rejects.toThrow();
});

test("unifies new project telegram originals and legacy roots without migrating them", async () => {
  const f = await fixture();
  const location = {
    projectPath: f.projectPath,
    rootDir: join(f.projectPath, "telegram"),
    layout: "project" as const,
    legacyRootDir: f.rootDir,
  };
  const added = await storeAttachment({
    ...location,
    scopeKey: "topic",
    data: new TextEncoder().encode("new"),
    originalName: "new.pdf",
    mimeType: "application/pdf",
    telegramFileId: "new",
  });
  const results = await scanAttachments(location);
  expect(results.entries.length).toBe(2);
  expect(results.bytes).toBe(8);
  for (const entry of results.entries) {
    await setAttachmentArchived(location, entry, true);
  }
  expect(
    (await scanAttachments(location)).entries.every((e) => e.archived)
  ).toBe(true);
  expect(await readFile(f.record.path, "utf8")).toBe("hello");
  expect(await readFile(added.path, "utf8")).toBe("new");
  const wrong = {
    ...location,
    legacyRootDir: join(f.projectPath, "unrelated"),
  };
  const legacy = results.entries.find((e) => e.record.path === f.record.path);
  if (!legacy) {
    throw new Error("Missing legacy");
  }
  await expect(setAttachmentArchived(wrong, legacy, true)).rejects.toThrow(
    "Percorso"
  );
});
