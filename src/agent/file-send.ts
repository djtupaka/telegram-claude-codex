import { join } from "node:path";

const REPO_DIR = new URL("../../", import.meta.url).pathname;
const ENV_FILE = join(REPO_DIR, ".env");
const SEND_FILE_SCRIPT = join(REPO_DIR, "scripts", "send-file-to-user.ts");

/** Build the prompt snippet for the explicitly authorized Telegram file sender. */
export const buildFileSystemPrompt = (chatId: number, threadId?: number) =>
  [
    "You can send files to the user's Telegram chat.",
    `To send a file, run: bun --env-file=${ENV_FILE} ${SEND_FILE_SCRIPT} --path <absolute-file-path> --chat ${chatId}${threadId === undefined ? "" : ` --thread ${threadId}`}`,
    "Only use this when the user explicitly asks you to send/share/download a file.",
    "The script blocks .env and other sensitive files automatically.",
  ].join(" ");
