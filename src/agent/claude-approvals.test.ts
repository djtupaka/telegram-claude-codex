import { expect, test } from "bun:test";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import "./registry";
import { buildOptions } from "./claude";
import type { RunOptions } from "./types";

const opts = {
  chatId: 1,
  userId: 1,
  projectDir: "/tmp",
  prompt: "hi",
  runId: "r",
  runKey: "k",
  approvalPolicy: "ask",
} as RunOptions;
const signal = new AbortController().signal;
const context = { signal, toolUseID: "tool", requestId: "req" };
const hookInput = (name: string) =>
  ({ hook_event_name: "PreToolUse", tool_name: name }) as HookInput;

test("ask mode forces a permission prompt for every tool, removes bypass", async () => {
  const options = buildOptions(
    opts,
    signal,
    { permissions: { allow: ["Bash(*)"] } },
    undefined
  );
  expect(options.permissionMode).toBe("default");
  expect(options.settings).toMatchObject({ disableAllHooks: false });
  expect(options.allowDangerouslySkipPermissions).toBe(false);
  const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
  for (const name of [
    "Bash",
    "Write",
    "Read",
    "mcp__executor__execute",
    "Agent",
  ]) {
    expect(await hook?.(hookInput(name), "tool", { signal })).toMatchObject({
      hookSpecificOutput: { permissionDecision: "ask" },
    });
  }
  expect(
    await options.canUseTool?.("Bash", { command: "python opaque.py" }, context)
  ).toMatchObject({ behavior: "deny" });
});

test("approval permits only the original call without persistent permissions", async () => {
  const options = buildOptions(
    { ...opts, requestApproval: async () => true },
    signal,
    {},
    undefined
  );
  const input = { command: "opaque" };
  expect(await options.canUseTool?.("Bash", input, context)).toEqual({
    behavior: "allow",
    updatedInput: input,
  });
  const denied = buildOptions(
    {
      ...opts,
      requestApproval: async () => {
        throw new Error("offline");
      },
    },
    signal,
    {},
    undefined
  );
  expect(await denied.canUseTool?.("Bash", input, context)).toMatchObject({
    behavior: "deny",
  });
});

test("readOnly denies execution and mutation despite a permissive approval callback", async () => {
  const options = buildOptions(
    { ...opts, readOnly: true, requestApproval: async () => true },
    signal,
    {},
    undefined
  );
  expect(options.tools).toEqual(["Read", "Glob", "Grep"]);
  const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
  for (const name of [
    "Bash",
    "Write",
    "mcp__executor__execute",
    "Agent",
    "WebFetch",
  ]) {
    expect(await hook?.(hookInput(name), "tool", { signal })).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(await options.canUseTool?.(name, {}, context)).toMatchObject({
      behavior: "deny",
    });
  }
  expect(await hook?.(hookInput("Read"), "tool", { signal })).toMatchObject({
    hookSpecificOutput: { permissionDecision: "allow" },
  });
});

test("aborted runs and aborted permission requests fail closed", async () => {
  const aborted = new AbortController();
  aborted.abort();
  const options = buildOptions(
    { ...opts, requestApproval: async () => true },
    aborted.signal,
    {},
    undefined
  );
  expect(options.abortController?.signal.aborted).toBe(true);
  expect(await options.canUseTool?.("Bash", {}, context)).toMatchObject({
    behavior: "deny",
  });
});

test("automation disables SDK session persistence", () => {
  expect(
    buildOptions({ ...opts, persistSession: false }, signal, {}, undefined)
      .persistSession
  ).toBe(false);
});

test("external cancellation reaches SDK controller and permission gate", async () => {
  const external = new AbortController();
  const options = buildOptions(
    { ...opts, signal: external.signal, requestApproval: async () => true },
    signal,
    {},
    undefined
  );
  external.abort();
  expect(options.abortController?.signal.aborted).toBe(true);
  expect(await options.canUseTool?.("Bash", {}, context)).toMatchObject({
    behavior: "deny",
  });
});

test("pre-aborted external cancellation reaches SDK before startup", () => {
  const external = new AbortController();
  external.abort();
  expect(
    buildOptions({ ...opts, signal: external.signal }, signal, {}, undefined)
      .abortController?.signal.aborted
  ).toBe(true);
});
