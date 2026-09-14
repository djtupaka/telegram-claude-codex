import { createHash } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import {
  lstat,
  open,
  opendir,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { AttachmentRecord } from "./attachments";

export interface AttachmentLocation {
  layout?: "project";
  legacyRootDir?: string;
  projectPath: string;
  rootDir: string;
}
export interface ManagedAttachment {
  archived: boolean;
  fingerprint: string;
  record: AttachmentRecord;
}
const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const safeName = (name: string) =>
  name
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9_\-.]/g, "_")
    .replace(/\.{2,}/g, "_")
    .slice(-120) || "allegato";
function projectDirectory(location: AttachmentLocation) {
  if (location.layout === "project") {
    return resolve(location.rootDir);
  }
  const project = resolve(location.projectPath);
  return join(
    resolve(location.rootDir),
    `${safeName(basename(project))}-${hash(project).slice(0, 16)}`
  );
}
const SHA256 = /^[a-f0-9]{64}$/;
function locations(location: AttachmentLocation): AttachmentLocation[] {
  const current = {
    rootDir: location.rootDir,
    projectPath: location.projectPath,
    layout: location.layout,
  };
  return location.legacyRootDir
    ? [
        current,
        { rootDir: location.legacyRootDir, projectPath: location.projectPath },
      ]
    : [current];
}
function entryLocation(
  location: AttachmentLocation,
  file: string
): AttachmentLocation {
  for (const candidate of locations(location)) {
    const directory = projectDirectory(candidate);
    const parts = file.slice(directory.length + 1).split("/");
    if (
      file.startsWith(`${directory}/`) &&
      parts.length === 3 &&
      parts.every((part) => part !== ".." && part !== ".")
    ) {
      return candidate;
    }
  }
  throw new Error("Percorso non valido per questo progetto.");
}
async function regularRead(path: string, max: number): Promise<Buffer> {
  // biome-ignore lint/suspicious/noBitwiseOperators: combine secure POSIX open flags
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > max) {
      throw new Error("File non valido o troppo grande.");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
async function checkedEntry(
  location: AttachmentLocation,
  manifest: string
): Promise<ManagedAttachment> {
  if ((await realpath(dirname(manifest))) !== dirname(manifest)) {
    throw new Error("Collegamento simbolico.");
  }
  const raw = await regularRead(manifest, 65_536);
  const record = JSON.parse(raw.toString()) as AttachmentRecord;
  const file = manifest.slice(0, -".metadata.json".length);
  if (
    record.version !== 1 ||
    record.path !== file ||
    record.projectPath !== resolve(location.projectPath) ||
    typeof record.originalName !== "string" ||
    typeof record.scopeKey !== "string" ||
    typeof record.mimeType !== "string" ||
    typeof record.sha256 !== "string" ||
    !SHA256.test(record.sha256) ||
    !Number.isSafeInteger(record.size) ||
    record.size < 0 ||
    !Number.isFinite(Date.parse(record.receivedAt))
  ) {
    throw new Error("Metadati non validi.");
  }
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== record.size) {
    throw new Error("Originale non valido.");
  }
  let marker = "";
  try {
    marker = (await regularRead(`${file}.archived.json`, 4096)).toString();
    if (JSON.parse(marker).sha256 !== record.sha256) {
      throw new Error("Archivio non valido.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return {
    record,
    archived: !!marker,
    fingerprint: hash(
      `${raw.toString()}\n${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}\n${marker}`
    ),
  };
}
export async function scanAttachments(
  location: AttachmentLocation & { search?: string }
) {
  const entries: ManagedAttachment[] = [];
  let skipped = 0;
  let visited = 0;
  let truncated = false;
  async function visit(
    path: string,
    item: Dirent,
    depth: number
  ): Promise<void> {
    const child = join(path, item.name);
    if (item.isSymbolicLink()) {
      skipped++;
      return;
    }
    if (item.isDirectory() && depth < 2) {
      await walk(child, depth + 1);
      return;
    }
    if (item.name.endsWith(".metadata.json") && depth === 2) {
      try {
        entries.push(await checkedEntry(location, child));
      } catch {
        skipped++;
      }
    }
  }
  async function walk(path: string, depth: number): Promise<void> {
    if ((await realpath(path)) !== path) {
      throw new Error("Percorso archivio con collegamenti simbolici.");
    }
    const dir = await opendir(path);
    for await (const item of dir) {
      if (++visited > 5000) {
        truncated = true;
        break;
      }
      await visit(path, item, depth);
      if (truncated) {
        break;
      }
    }
  }
  for (const directory of new Set(locations(location).map(projectDirectory))) {
    try {
      await walk(directory, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    if (truncated) {
      break;
    }
  }
  entries.sort((a, b) =>
    b.record.receivedAt.localeCompare(a.record.receivedAt)
  );
  const bytes = entries.reduce((sum, entry) => sum + entry.record.size, 0);
  const archivedBytes = entries
    .filter((e) => e.archived)
    .reduce((sum, e) => sum + e.record.size, 0);
  const search = location.search?.trim().toLocaleLowerCase("it") ?? "";
  return {
    entries: entries.filter((e) =>
      e.record.originalName.toLocaleLowerCase("it").includes(search)
    ),
    bytes,
    archivedBytes,
    total: entries.length,
    skipped,
    truncated,
  };
}
const locks = new Set<string>();
export async function setAttachmentArchived(
  allowedLocation: AttachmentLocation,
  entry: ManagedAttachment,
  archived: boolean
): Promise<void> {
  const file = entry.record.path;
  const location = entryLocation(allowedLocation, file);
  if (locks.has(file)) {
    throw new Error("Operazione già in corso.");
  }
  locks.add(file);
  try {
    const relative = file
      .slice(projectDirectory(location).length + 1)
      .split("/");
    if (
      !file.startsWith(`${projectDirectory(location)}/`) ||
      relative.length !== 3 ||
      relative.some((p) => p === ".." || p === ".")
    ) {
      throw new Error("Percorso non valido.");
    }
    const current = await checkedEntry(location, `${file}.metadata.json`);
    if (current.fingerprint !== entry.fingerprint) {
      throw new Error("Anteprima scaduta: aggiorna l’elenco.");
    }
    const payload = await regularRead(file, 100 * 1024 * 1024);
    if (hash(payload) !== current.record.sha256) {
      throw new Error("Integrità originale non verificata.");
    }
    const latest = await checkedEntry(location, `${file}.metadata.json`);
    if (latest.fingerprint !== current.fingerprint) {
      throw new Error("Originale modificato durante la verifica.");
    }
    if (archived === current.archived) {
      return;
    }
    if (archived) {
      await writeFile(
        `${file}.archived.json`,
        JSON.stringify({
          sha256: current.record.sha256,
          archivedAt: new Date().toISOString(),
        }),
        { flag: "wx", mode: 0o600 }
      );
    } else {
      await unlink(`${file}.archived.json`);
    }
  } finally {
    locks.delete(file);
  }
}

export async function purgeAttachment(
  allowedLocation: AttachmentLocation,
  entry: ManagedAttachment
) {
  const location = entryLocation(allowedLocation, entry.record.path);
  const file = entry.record.path;
  if (locks.has(file)) {
    throw new Error("Operazione già in corso.");
  }
  locks.add(file);
  try {
    const current = await checkedEntry(location, `${file}.metadata.json`);
    if (current.fingerprint !== entry.fingerprint) {
      throw new Error("Anteprima scaduta.");
    }
    const payload = await regularRead(file, 100 * 1024 * 1024);
    if (hash(payload) !== entry.record.sha256) {
      throw new Error("Integrità originale non verificata.");
    }
    const latest = await checkedEntry(location, `${file}.metadata.json`);
    if (latest.fingerprint !== entry.fingerprint) {
      throw new Error("Originale cambiato: rimozione annullata.");
    }
    await unlink(file);
    await unlink(`${file}.metadata.json`);
    if (current.archived) {
      await unlink(`${file}.archived.json`);
    }
    return { bytes: entry.record.size };
  } finally {
    locks.delete(file);
  }
}
