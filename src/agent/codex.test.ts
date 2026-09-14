import { expect, test } from "bun:test";
import "./registry";
import { buildCodexPrompt, codexProvider } from "./codex";
import type { RunOptions } from "./types";

const opts = {
  chatId: -100,
  threadId: 12,
  projectDir: "/tmp",
  prompt: "ciao",
  userId: 1,
  runId: "r",
  runKey: "k",
} satisfies RunOptions;

test("resumed Codex prompts retain current topic destination", () => {
  expect(buildCodexPrompt({ ...opts, sessionId: "session" })).toContain(
    "--chat -100 --thread 12"
  );
});

test("Codex rejects ask and readOnly before constructing SDK", async () => {
  if (codexProvider.kind !== "sdk") {
    throw new Error("Expected SDK");
  }
  for (const policy of [
    { approvalPolicy: "ask" as const },
    { readOnly: true },
  ]) {
    const gen = codexProvider.run(
      { ...opts, ...policy },
      new AbortController().signal
    );
    const result = await gen.next();
    expect(result.value).toMatchObject({ kind: "error" });
    expect((await gen.next()).done).toBe(true);
  }
});
