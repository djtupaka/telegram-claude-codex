import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { basename, join, parse, resolve, sep } from "node:path";

export interface AttachmentInput {
  data: Uint8Array;
  layout?: "project";
  mimeType: string;
  originalName: string;
  projectPath: string;
  receivedAt?: Date;
  rootDir: string;
  scopeKey: string;
  telegramFileId: string;
  telegramFileUniqueId?: string;
}
export interface AttachmentRecord {
  mimeType: string;
  originalName: string;
  path: string;
  projectPath: string;
  receivedAt: string;
  scopeKey: string;
  sha256: string;
  size: number;
  telegramFileId: string;
  telegramFileUniqueId?: string;
  version: 1;
}

const UNSAFE_NAME = /[^a-zA-Z0-9_\-.]/g;
const DOT_RUN = /\.{2,}/g;
const MAX_NAME_LENGTH = 120;
const HASH_LENGTH = 16;
const DATE_LENGTH = 10;
const safeName = (name: string) =>
  name
    .normalize("NFKC")
    .replace(UNSAFE_NAME, "_")
    .replace(DOT_RUN, "_")
    .slice(-MAX_NAME_LENGTH) || "allegato";
const digest = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
const folder = (label: string, identity: string) =>
  `${safeName(label)}-${digest(identity).slice(0, HASH_LENGTH)}`;

// Reject pre-existing symlink components so an archive cannot redirect writes.
async function privateDirectory(directory: string): Promise<void> {
  const root = parse(directory).root;
  let current = root;
  for (const component of directory
    .slice(root.length)
    .split(sep)
    .filter(Boolean)) {
    current = join(current, component);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(
        "Percorso archivio non valido: collegamento simbolico o file."
      );
    }
  }
}

export async function storeAttachment(
  input: AttachmentInput
): Promise<AttachmentRecord> {
  const projectPath = resolve(input.projectPath);
  const receivedAt = (input.receivedAt ?? new Date()).toISOString();
  const directory = join(
    resolve(input.rootDir),
    ...(input.layout === "project"
      ? []
      : [folder(basename(projectPath), projectPath)]),
    folder(input.scopeKey, input.scopeKey),
    receivedAt.slice(0, DATE_LENGTH)
  );
  await privateDirectory(directory);
  if (input.layout === "project") {
    try {
      await writeFile(join(resolve(input.rootDir), ".gitignore"), "*\n", {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const ignoreInfo = await lstat(
        join(resolve(input.rootDir), ".gitignore")
      );
      if (!ignoreInfo.isFile() || ignoreInfo.isSymbolicLink()) {
        throw new Error(
          "File .gitignore non valido: collegamento simbolico o directory."
        );
      }
    }
  }
  const path = join(
    directory,
    `${randomUUID()}-${safeName(input.originalName)}`
  );
  const record: AttachmentRecord = {
    version: 1,
    projectPath,
    scopeKey: input.scopeKey,
    originalName: input.originalName,
    mimeType: input.mimeType,
    telegramFileId: input.telegramFileId,
    ...(input.telegramFileUniqueId
      ? { telegramFileUniqueId: input.telegramFileUniqueId }
      : {}),
    sha256: digest(input.data),
    path,
    receivedAt,
    size: input.data.byteLength,
  };
  await writeFile(path, input.data, { flag: "wx", mode: 0o600 });
  // One manifest per original prevents lost metadata during concurrent uploads.
  // Preserve the original even if a subsequent metadata write fails.
  await writeFile(
    `${path}.metadata.json`,
    `${JSON.stringify(record, null, 2)}\n`,
    { flag: "wx", mode: 0o600 }
  );
  return record;
}
