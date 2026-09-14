import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildFileSystemPrompt } from "./file-send";

describe("buildFileSystemPrompt", () => {
  test("loads credentials from the private env file only in the send script", () => {
    const prompt = buildFileSystemPrompt(74_919_235);
    const repoDir = new URL("../../", import.meta.url).pathname;

    expect(prompt).toContain(`bun --env-file=${join(repoDir, ".env")}`);
    expect(prompt).toContain(join(repoDir, "scripts", "send-file-to-user.ts"));
    expect(prompt).toContain("--chat 74919235");
    expect(prompt).not.toContain("telegram-secret");
  });
});

test("topic destination is explicit in the file sender instruction", () => {
  expect(buildFileSystemPrompt(-100, 12)).toContain("--chat -100 --thread 12");
});
