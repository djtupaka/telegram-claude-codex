/**
 * One-shot: create the initial forum topics (sessions) in the Dev group.
 * Usage: bun run scripts/topics-seed.ts <chatId> <project>:<provider>[:<name>] ...
 * Example: bun run scripts/topics-seed.ts -1001234567890 progetto:codex progetto:claude
 * Reads BOT_TOKEN and PROJECTS_DIR from .env (bun loads it automatically).
 */
import { Api } from "grammy";
import { createTopicSession } from "../src/topics";

const [chatIdArg, ...specs] = process.argv.slice(2);
const token = process.env.BOT_TOKEN;
const projectsDir = process.env.PROJECTS_DIR ?? "/home/agent/projects";
if (!(token && chatIdArg) || specs.length === 0) {
  console.error(
    "usage: bun run scripts/topics-seed.ts <chatId> <project>:<claude|codex>[:<name>] ..."
  );
  process.exit(1);
}
const chatId = Number.parseInt(chatIdArg, 10);
const api = new Api(token);
for (const spec of specs) {
  const [projectName, provider, ...rest] = spec.split(":");
  if (!projectName || (provider !== "claude" && provider !== "codex")) {
    console.error(`skip malformed spec: ${spec}`);
    continue;
  }
  const created = await createTopicSession({
    api,
    chatId,
    projectName,
    projectsDir,
    provider,
    customName: rest.join(":") || undefined,
  });
  console.log(`created ${created.name} (thread ${created.threadId})`);
}
