import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getProvider, listProviders } from "./agent/registry";
import type { ProviderId } from "./agent/types";

export interface ProjectPreference {
  effort: string;
  model: string;
  provider: ProviderId;
}
function validate(value: unknown): ProjectPreference {
  if (!value || typeof value !== "object") {
    throw new Error("Preferenze progetto non valide.");
  }
  const item = value as ProjectPreference;
  if (!listProviders().some((provider) => provider.id === item.provider)) {
    throw new Error("Assistente preferito non valido.");
  }
  const provider = getProvider(item.provider);
  if (
    !(
      provider.models.some((model) => model.id === item.model) ||
      item.model === provider.defaultModel
    )
  ) {
    throw new Error("Modello preferito non valido.");
  }
  if (
    !(
      provider.effortLevels.some((effort) => effort.id === item.effort) ||
      item.effort === "default"
    )
  ) {
    throw new Error("Ragionamento preferito non valido.");
  }
  return { provider: item.provider, model: item.model, effort: item.effort };
}
export function makeProjectPreferencesStore(
  filePath = join(import.meta.dir, "..", ".data", "project-preferences.json")
) {
  const read = (): Record<string, ProjectPreference> => {
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw error;
    }
    const value = JSON.parse(raw);
    if (
      value?.version !== 1 ||
      !value.projects ||
      typeof value.projects !== "object" ||
      Array.isArray(value.projects)
    ) {
      throw new Error("Archivio preferenze non valido: file preservato.");
    }
    const projects: Record<string, ProjectPreference> = Object.create(null);
    for (const [key, preference] of Object.entries(value.projects)) {
      projects[key] = validate(preference);
    }
    return projects;
  };
  const mutate = (
    update: (projects: Record<string, ProjectPreference>) => void
  ) => {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    const lockPath = `${filePath}.lock`;
    const lock = openSync(lockPath, "wx", 0o600);
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      const projects = read();
      update(projects);
      const fd = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ version: 1, projects }, null, 2));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, filePath);
    } finally {
      rmSync(temporary, { force: true });
      closeSync(lock);
      rmSync(lockPath, { force: true });
    }
  };
  return {
    get(projectPath: string): ProjectPreference | undefined {
      return read()[realpathSync(projectPath)];
    },
    set(projectPath: string, preference: ProjectPreference) {
      const key = realpathSync(projectPath);
      const valid = validate(preference);
      mutate((projects) => {
        projects[key] = valid;
      });
    },
    remove(projectPath: string): boolean {
      const key = realpathSync(projectPath);
      let found = false;
      mutate((projects) => {
        found = Object.hasOwn(projects, key);
        delete projects[key];
      });
      return found;
    },
  };
}
export const projectPreferences = makeProjectPreferencesStore();
export function getNewTopicPreferences(
  projectPath: string,
  chosenProvider: ProviderId,
  store = projectPreferences
) {
  const preference = store.get(projectPath);
  const models: Partial<Record<ProviderId, string>> = {};
  const efforts: Partial<Record<ProviderId, string>> = {};
  if (preference?.provider === chosenProvider) {
    models[chosenProvider] = preference.model;
    efforts[chosenProvider] = preference.effort;
  }
  return { models, efforts };
}
