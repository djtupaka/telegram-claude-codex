import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

interface RecipientConfig {
  allowedChatIds?: string;
  allowedUserId?: string;
  topics?: unknown;
}

const SENSITIVE =
  /^(?:\.env|credentials|secrets|id_rsa|id_ed25519)|\.(?:pem|key)$/i;

export function validateRecipient(
  chatId: number,
  threadId: number | undefined,
  config: RecipientConfig
): void {
  if (!Number.isSafeInteger(chatId) || chatId === 0) {
    throw new Error("Destinatario non valido.");
  }
  if (
    chatId > 0 &&
    config.allowedUserId?.trim() === String(chatId) &&
    threadId === undefined
  ) {
    return;
  }
  const allowed =
    config.allowedChatIds?.split(",").map((value) => value.trim()) ?? [];
  if (
    chatId >= 0 ||
    !allowed.includes(String(chatId)) ||
    !Number.isSafeInteger(threadId) ||
    (threadId ?? 0) <= 0
  ) {
    throw new Error("Destinatario o argomento non autorizzato.");
  }
  const topicFile = config.topics as
    | { topics?: Record<string, { chatId?: unknown; threadId?: unknown }> }
    | undefined;
  const record = topicFile?.topics?.[`t:${chatId}:${threadId}`];
  if (record?.chatId !== chatId || record.threadId !== threadId) {
    throw new Error("Argomento non registrato.");
  }
}

interface DeliveryOptions {
  chatId: number;
  config: RecipientConfig;
  filePath: string;
  receiptDir: string;
  threadId?: number;
  token: string;
}

type SendRequest = (url: string, init: RequestInit) => Promise<Response>;

/** Snapshot the document once: uploaded bytes and receipt checksum always agree. */
export async function deliverFile(
  options: DeliveryOptions,
  send: SendRequest = fetch
) {
  validateRecipient(options.chatId, options.threadId, options.config);
  if (!options.token.trim()) {
    throw new Error("Token Telegram non configurato.");
  }
  const path = await realpath(options.filePath);
  const name = basename(options.filePath);
  if (SENSITIVE.test(name) || SENSITIVE.test(basename(path))) {
    throw new Error("Invio bloccato: file sensibile.");
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags require a bit mask.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error("Il documento deve essere un file regolare.");
    }
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  await mkdir(options.receiptDir, { recursive: true, mode: 0o700 });
  const form = new FormData();
  form.append("chat_id", String(options.chatId));
  if (options.threadId !== undefined) {
    form.append("message_thread_id", String(options.threadId));
  }
  form.append("document", new Blob([new Uint8Array(bytes)]), name);
  let data: {
    ok?: boolean;
    result?: {
      message_id?: number;
      chat?: { id?: number };
      message_thread_id?: number;
    };
  };
  try {
    const response = await send(
      `https://api.telegram.org/bot${options.token}/sendDocument`,
      { method: "POST", body: form, signal: AbortSignal.timeout(60_000) }
    );
    if (!response.ok) {
      throw new Error("HTTP");
    }
    data = await response.json();
    if (
      !(data.ok && Number.isSafeInteger(data.result?.message_id)) ||
      data.result?.chat?.id !== options.chatId ||
      data.result?.message_thread_id !== options.threadId
    ) {
      throw new Error("Risposta inattesa");
    }
  } catch {
    // Never surface fetch URLs, API descriptions, or response bodies (token risk).
    throw new Error(
      "Invio Telegram non riuscito. Verificare la destinazione prima di riprovare."
    );
  }
  const receipt = {
    path,
    name,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    chatId: options.chatId,
    threadId: options.threadId ?? null,
    messageId: data.result?.message_id,
    timestamp: new Date().toISOString(),
  };
  const receiptPath = join(options.receiptDir, `${randomUUID()}.json`);
  try {
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
  } catch {
    throw new Error(
      "Documento inviato, ma ricevuta locale non salvata. Non ripetere l'invio."
    );
  }
  return { ...receipt, receiptPath };
}
