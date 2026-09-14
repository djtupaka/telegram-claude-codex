import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectFolder } from "./project-folders";

test("creates an empty project directly under projects", () => {
  const root = mkdtempSync(join(tmpdir(), "new-project-"));
  expect(createProjectFolder(root, "my-project")).toBe(
    join(root, "my-project")
  );
});
test("rejects traversal, hidden and invalid names", () => {
  const root = mkdtempSync(join(tmpdir(), "new-project-"));
  for (const name of [
    "../outside",
    "/tmp/x",
    ".hidden",
    "a/b",
    "a\\b",
    "",
    "a b",
    "..",
    "x".repeat(41),
  ]) {
    expect(() => createProjectFolder(root, name)).toThrow();
  }
});
test("never overwrites existing projects or follows a colliding symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "new-project-"));
  const project = createProjectFolder(root, "existing");
  writeFileSync(join(project, "keep.txt"), "original");
  expect(() => createProjectFolder(root, "existing")).toThrow("esiste già");
  expect(readFileSync(join(project, "keep.txt"), "utf8")).toBe("original");
  symlinkSync(project, join(root, "alias"));
  expect(() => createProjectFolder(root, "alias")).toThrow("esiste già");
});

test("missing configured root gives an Italian operational error", () => {
  const root = mkdtempSync(join(tmpdir(), "new-project-"));
  expect(() => createProjectFolder(join(root, "missing"), "demo")).toThrow(
    "Verifica il percorso e i permessi su Ubuntu"
  );
});
