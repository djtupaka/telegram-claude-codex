#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deliverFile } from "../src/file-delivery";

const readFlag = (flag: string) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

async function main() {
  const positional = process.argv[2]?.startsWith("--")
    ? undefined
    : process.argv[2];
  const filePath = readFlag("--path") ?? positional;
  const chat = readFlag("--chat") ?? process.env.TELEGRAM_CHAT_ID;
  const thread = readFlag("--thread");
  if (!(filePath && chat && process.env.BOT_TOKEN)) {
    throw new Error(
      "Uso: send-file-to-user.ts --path <file> --chat <chatId> [--thread <threadId>]. Configurare BOT_TOKEN."
    );
  }
  const dataDir = fileURLToPath(new URL("../.data/", import.meta.url));
  let topics: unknown;
  try {
    topics = JSON.parse(await readFile(join(dataDir, "topics.json"), "utf8"));
  } catch {
    // Missing or invalid topic registry denies group delivery.
  }
  const receipt = await deliverFile({
    filePath,
    chatId: Number(chat),
    threadId: thread === undefined ? undefined : Number(thread),
    token: process.env.BOT_TOKEN,
    receiptDir: join(dataDir, "deliveries"),
    config: {
      allowedUserId: process.env.ALLOWED_USER_ID,
      allowedChatIds: process.env.ALLOWED_CHAT_IDS,
      topics,
    },
  });
  console.log(JSON.stringify(receipt));
}

try {
  await main();
} catch (error) {
  // Only locally generated errors reach this boundary; network errors are sanitized.
  console.error(error instanceof Error ? error.message : "Invio non riuscito.");
  process.exitCode = 1;
}
