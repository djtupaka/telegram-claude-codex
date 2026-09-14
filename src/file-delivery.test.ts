import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverFile, validateRecipient } from "./file-delivery";

const config = {
  allowedUserId: "1",
  allowedChatIds: "-100",
  topics: { topics: { "t:-100:12": { chatId: -100, threadId: 12 } } },
};

test("recipient must be configured and groups require the registered topic", () => {
  expect(() => validateRecipient(1, undefined, config)).not.toThrow();
  expect(() => validateRecipient(-100, 12, config)).not.toThrow();
  for (const [chat, thread] of [
    [2, undefined],
    [-100, undefined],
    [-100, 13],
    [-100, 0],
    [1, 12],
  ] as const) {
    expect(() => validateRecipient(chat, thread, config)).toThrow();
  }
  expect(() => validateRecipient(1, undefined, {})).toThrow();
});

test("file sender preserves name and topic and writes a sha256 delivery receipt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "delivery-"));
  try {
    const filePath = join(dir, "Documento originale.pdf");
    await writeFile(filePath, "pdf content");
    const result = await deliverFile(
      {
        filePath,
        chatId: -100,
        threadId: 12,
        token: "secret",
        config,
        receiptDir: join(dir, "receipts"),
      },
      async (_url, init) => {
        const form = init.body as FormData;
        expect(form.get("message_thread_id")).toBe("12");
        expect((form.get("document") as File).name).toBe(
          "Documento originale.pdf"
        );
        return Response.json({
          ok: true,
          result: { message_id: 99, chat: { id: -100 }, message_thread_id: 12 },
        });
      }
    );
    const receipt = JSON.parse(await readFile(result.receiptPath, "utf8"));
    expect(receipt).toMatchObject({
      name: "Documento originale.pdf",
      chatId: -100,
      threadId: 12,
      messageId: 99,
      path: filePath,
    });
    expect(receipt.sha256).toHaveLength(64);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("symlink to sensitive file is denied before network and fetch errors never expose token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "delivery-"));
  try {
    await writeFile(join(dir, ".env"), "secret");
    await symlink(join(dir, ".env"), join(dir, "safe.pdf"));
    let called = false;
    const base = {
      chatId: 1,
      token: "telegram-secret",
      config,
      receiptDir: join(dir, "receipts"),
    };
    await expect(
      deliverFile({ ...base, filePath: join(dir, "safe.pdf") }, () => {
        called = true;
        throw new Error("unexpected");
      })
    ).rejects.toThrow("sensibile");
    expect(called).toBe(false);
    await writeFile(join(dir, "ok.pdf"), "pdf");
    await expect(
      deliverFile({ ...base, filePath: join(dir, "ok.pdf") }, () => {
        throw new Error("https://telegram/telegram-secret");
      })
    ).rejects.toThrow("Invio Telegram non riuscito");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
