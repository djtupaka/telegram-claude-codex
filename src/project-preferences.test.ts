import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProvider } from "./agent/registry";
import {
  getNewTopicPreferences,
  makeProjectPreferencesStore,
} from "./project-preferences";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "project-preferences-"));
  directories.push(dir);
  const project = join(dir, "project");
  mkdirSync(project);
  const file = join(dir, "data", "prefs.json");
  return { dir, project, file, store: makeProjectPreferencesStore(file) };
}
const provider = getProvider("codex");
const prefs = {
  provider: "codex" as const,
  model: provider.defaultModel,
  effort: provider.defaultEffort,
};
test("preferences persist by canonical project and stay private", () => {
  const { dir, project, file, store } = fixture();
  expect(store.get(project)).toBeUndefined();
  store.set(project, prefs);
  const alias = join(dir, "alias");
  symlinkSync(project, alias);
  expect(makeProjectPreferencesStore(file).get(alias)).toEqual(prefs);
  expect(statSync(file).mode % 0o1000).toBe(0o600);
  expect(store.remove(alias)).toBe(true);
  expect(store.get(project)).toBeUndefined();
});
test("independent stores preserve other projects and validate values", () => {
  const { dir, project, file, store } = fixture();
  const second = join(dir, "other");
  mkdirSync(second);
  const other = makeProjectPreferencesStore(file);
  store.set(project, prefs);
  other.set(second, prefs);
  expect(store.get(second)).toEqual(prefs);
  expect(() => store.set(project, { ...prefs, model: "invented" })).toThrow();
  expect(() => store.set(project, { ...prefs, effort: "invented" })).toThrow();
  expect(() =>
    store.set(project, { ...prefs, provider: "unknown" as "codex" })
  ).toThrow();
  expect(store.get(project)).toEqual(prefs);
});
test("corrupt store fails closed and is never overwritten", () => {
  const { project, file, store } = fixture();
  store.set(project, prefs);
  writeFileSync(file, "{broken");
  expect(() => store.get(project)).toThrow();
  expect(() => store.set(project, prefs)).toThrow();
  expect(() => store.remove(project)).toThrow();
  expect(readFileSync(file, "utf8")).toBe("{broken");
});
test("new topics use preferences only for the explicitly selected provider", () => {
  const { project, store } = fixture();
  expect(getNewTopicPreferences(project, "codex", store)).toEqual({
    models: {},
    efforts: {},
  });
  store.set(project, prefs);
  expect(getNewTopicPreferences(project, "codex", store)).toEqual({
    models: { codex: prefs.model },
    efforts: { codex: prefs.effort },
  });
  expect(getNewTopicPreferences(project, "claude", store)).toEqual({
    models: {},
    efforts: {},
  });
});
test("invalid stored values block reads and mutations without destroying evidence", () => {
  const { project, file, store } = fixture();
  store.set(project, prefs);
  const bad = JSON.stringify({
    version: 1,
    projects: { [project]: { ...prefs, effort: "removed" } },
  });
  writeFileSync(file, bad);
  expect(() => store.get(project)).toThrow();
  expect(() => store.set(project, prefs)).toThrow();
  expect(readFileSync(file, "utf8")).toBe(bad);
});
