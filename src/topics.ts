import { statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Api } from "grammy";
import { getProvider } from "./agent/registry";
import type { ProviderId } from "./agent/types";
import { getNewTopicPreferences } from "./project-preferences";
import { topicKey } from "./scope";
import { type TopicRecord, topicOps } from "./state";

/** Display names for well-known project folders; others get a capital initial. */
const PROJECT_LABELS: Readonly<Record<string, string>> = {
  premelone: "PremelOne",
  nodarr: "Nodarr",
  laura: "Laura",
  it_home: "Infrastruttura",
  "dev-bot": "Dev-bot",
  tdarr: "Tdarr",
  homeassistant: "Home Assistant",
  "coolify-setup": "Coolify",
  truenas: "TrueNAS",
};

/** Short provider tags used in topic names (CC = Claude Code, CX = Codex). */
const PROVIDER_SHORT: Readonly<Record<ProviderId, string>> = {
  claude: "CC",
  codex: "CX",
};

export const providerShort = (provider: ProviderId) =>
  PROVIDER_SHORT[provider] ?? getProvider(provider).displayName;

export const projectLabel = (name: string) =>
  PROJECT_LABELS[name] ?? name.charAt(0).toUpperCase() + name.slice(1);

export const topicDisplayName = (
  projectName: string,
  provider: ProviderId,
  customName?: string
) => {
  const base = customName?.trim() || projectLabel(projectName);
  return `${base} · ${providerShort(provider)}`;
};

export interface CreateTopicInput {
  api: Pick<Api, "createForumTopic" | "sendMessage">;
  chatId: number;
  customName?: string;
  projectName: string;
  projectsDir: string;
  provider: ProviderId;
}

export interface CreatedTopic {
  key: string;
  name: string;
  projectDir: string;
  record: TopicRecord;
  threadId: number;
}

/**
 * Create a forum topic bound to (project, provider), persist it, and post an
 * intro message inside it. Shared by /nuova and the seed script.
 */
export async function createTopicSession(
  input: CreateTopicInput
): Promise<CreatedTopic> {
  const projectDir = join(input.projectsDir, input.projectName);
  if (!statSync(projectDir).isDirectory()) {
    throw new Error(`Cartella del progetto non trovata: ${projectDir}`);
  }
  getProvider(input.provider); // throws on unknown provider
  const name = topicDisplayName(
    input.projectName,
    input.provider,
    input.customName
  );
  const preferences = getNewTopicPreferences(projectDir, input.provider);
  const topic = await input.api.createForumTopic(input.chatId, name);
  const threadId = topic.message_thread_id;
  const key = topicKey(input.chatId, threadId);
  const record: TopicRecord = {
    activeProject: projectDir,
    activeProvider: input.provider,
    chatId: input.chatId,
    createdAt: new Date().toISOString(),
    ...preferences,
    name,
    threadId,
  };
  topicOps.upsert(key, record);
  await input.api.sendMessage(
    input.chatId,
    `Sessione pronta: ${name}\nProgetto: ${basename(projectDir)}\nScrivi qui per lavorare. /new azzera la conversazione, /chiudi archivia l'argomento.`,
    { message_thread_id: threadId }
  );
  return { key, name, projectDir, record, threadId };
}
