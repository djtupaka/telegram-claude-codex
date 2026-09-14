// biome-ignore-all lint/suspicious/noMisplacedAssertion: Standalone assertion harness executed in an isolated subprocess by bot-integration.test.ts.
/** Invoked only by bot-integration.test.ts inside a temporary copy of src. */
import { mock } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Update } from "grammy/types";
import type { AgentEvent, RunOptions } from "../src/agent/types";

const root = join(import.meta.dir, "..");
assert(
  root.includes("dev-bot-integration-"),
  "Harness requires an isolated temporary copy"
);
let networkCalls = 0;
globalThis.fetch = (() => {
  networkCalls++;
  throw new Error("Network forbidden in integration harness");
}) as unknown as typeof fetch;
// Lifecycle telemetry is unrelated to routing; never construct config/cloud SDK resources.
mock.module(join(root, "src/runtime.ts"), () => ({
  runtime: {
    runPromise: async () => undefined,
    runFork: () => undefined,
    runSync: () => undefined,
  },
}));
const agent = await import("../src/agent");
let agentCalls = 0;
let releaseFirst = () => {
  /* Replaced by controlled run. */
};
const firstReleased = new Promise<void>((resolve) => {
  releaseFirst = resolve;
});
let markStarted = () => {
  /* Replaced by start notification. */
};
const firstStarted = new Promise<void>((resolve) => {
  markStarted = resolve;
});
const agentPrompts: string[] = [];
mock.module(join(root, "src/agent/index.ts"), () => ({
  ...agent,
  async *runAgent(
    _provider: string,
    options: RunOptions
  ): AsyncGenerator<AgentEvent> {
    agentCalls++;
    agentPrompts.push(options.prompt);
    if (options.prompt === "Prima richiesta controllata") {
      markStarted();
      await firstReleased;
    }
    yield { kind: "text_delta", text: "Verifica conclusa" };
    yield {
      kind: "result",
      text: "Verifica conclusa",
      sessionId: "",
      durationMs: 1,
    };
  },
}));
const git = await import("../src/git");
mock.module(join(root, "src/git.ts"), () => ({
  ...git,
  getCurrentBranch: () => "test",
}));
const { createBot, stopBotOperations } = await import("../src/bot");
const { makeOperationsStore } = await import("../src/operations");
mkdirSync(join(root, ".data"), { recursive: true });
const topic = (threadId: number) => ({
  chatId: -100,
  threadId,
  activeProject: root,
  activeProvider: "codex",
  models: {},
  efforts: {},
  createdAt: new Date().toISOString(),
  name: `Test ${threadId}`,
});
writeFileSync(
  join(root, ".data", "topics.json"),
  JSON.stringify({
    version: 1,
    topics: { "t:-100:7": topic(7), "t:-100:8": topic(8) },
  })
);
const operations = makeOperationsStore(join(root, ".data", "operations.json"));
const bot = createBot("123:test", 42, root, 0, [-100]);
bot.botInfo = {
  id: 123,
  is_bot: true,
  first_name: "Test",
  username: "test_bot",
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
} as typeof bot.botInfo;
const calls: { method: string; payload: Record<string, unknown> }[] = [];
let messageId = 100;
bot.api.config.use((_previous, method, payload) => {
  const p = payload as Record<string, unknown>;
  calls.push({ method, payload: p });
  if (method === "createForumTopic") {
    return Promise.resolve({
      ok: true,
      result: { message_thread_id: 55, name: p.name },
    }) as never;
  }
  const result =
    method === "sendMessage"
      ? {
          message_id: messageId++,
          date: 1,
          chat: { id: p.chat_id, type: "supergroup" },
          text: p.text,
          message_thread_id: p.message_thread_id,
        }
      : true;
  return Promise.resolve({ ok: true, result }) as never;
});
let updateId = 1;
function message(text: string, thread = 7, user = 42, chat = -100): Update {
  return {
    update_id: updateId++,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: chat, type: "supergroup", title: "Test" },
      from: { id: user, is_bot: false, first_name: "Test" },
      text,
      is_topic_message: thread > 0,
      message_thread_id: thread || undefined,
      entities: text.startsWith("/")
        ? [
            {
              type: "bot_command",
              offset: 0,
              length: text.split(" ")[0]?.length ?? 0,
            },
          ]
        : undefined,
    },
  };
}
function callback(thread = 7, user = 42, chat = -100): Update {
  return {
    update_id: updateId++,
    callback_query: {
      id: `callback-${updateId}`,
      from: { id: user, is_bot: false, first_name: "Test" },
      chat_instance: "test",
      data: `approval:${"a".repeat(32)}:allow`,
      message: {
        message_id: 99,
        date: 1,
        chat: { id: chat, type: "supergroup", title: "Test" },
        is_topic_message: thread > 0,
        message_thread_id: thread || undefined,
      },
    },
  };
}
try {
  const beforeStatus = calls.length;
  await bot.handleUpdate(message("/status"));
  assert(
    calls
      .slice(beforeStatus)
      .some(
        (c) =>
          (c.payload.reply_markup as { remove_keyboard?: boolean } | undefined)
            ?.remove_keyboard === true
      ),
    "Status must remove the old persistent keyboard"
  );
  // Both fresh Italian keyboards and older English keyboards remain commands.
  for (const [label, expected] of [
    ["Progetti", "Scegli un progetto"],
    ["Projects", "Scegli un progetto"],
    ["Cronologia", "Nessuna sessione precedente trovata"],
    ["History", "Nessuna sessione precedente trovata"],
    ["Interrompi", "Nessuna esecuzione in corso"],
    ["Stop", "Nessuna esecuzione in corso"],
    ["Nuova sessione", "Sessione azzerata"],
    ["New", "Sessione azzerata"],
    ["Componi", "Composizione attiva"],
    ["Compose", "Composizione attiva"],
  ]) {
    const before = calls.length;
    await bot.handleUpdate(message(label as string));
    assert(
      calls
        .slice(before)
        .some((c) => String(c.payload.text).includes(expected as string)),
      `Keyboard label ${label} must dispatch its command`
    );
    await bot.handleUpdate(message("/cancel"));
  }
  assert.equal(
    agentCalls,
    0,
    "Keyboard labels must never become agent prompts"
  );
  await bot.handleUpdate(message("/help"));
  assert(calls.some((c) => String(c.payload.text).includes("<b>Comandi:</b>")));
  await bot.handleUpdate(message("/menu", 0));
  assert(
    calls.some((c) =>
      (JSON.stringify(c.payload.reply_markup) ?? "").includes("menu:topics:0")
    ),
    "General must show interactive navigation"
  );
  await bot.handleUpdate(message("/menu", 7));
  assert(
    calls.some(
      (c) =>
        c.payload.message_thread_id === 7 &&
        (JSON.stringify(c.payload.reply_markup) ?? "").includes("menu:settings")
    ),
    "Topic must show its settings menu"
  );
  const providerMenu = callback(7);
  if (providerMenu.callback_query) {
    providerMenu.callback_query.data = "menu:run:provider";
  }
  await bot.handleUpdate(providerMenu);
  assert(
    calls.some(
      (c) =>
        c.payload.message_thread_id === 7 &&
        (JSON.stringify(c.payload.reply_markup) ?? "").includes(
          "provider:claude"
        )
    ),
    "Menu must dispatch the existing provider command inside its topic"
  );
  const generalSetting = callback(0);
  if (generalSetting.callback_query) {
    generalSetting.callback_query.data = "menu:permission:ask";
  }
  await bot.handleUpdate(generalSetting);
  assert.equal(operations.getSettings("c:-100").approvalPolicy, "automatic");
  const menuPermission = callback(7);
  if (menuPermission.callback_query) {
    menuPermission.callback_query.data = "menu:permission:ask";
  }
  await bot.handleUpdate(menuPermission);
  assert.equal(operations.getSettings("t:-100:7").approvalPolicy, "ask");
  assert.equal(operations.getSettings("t:-100:8").approvalPolicy, "automatic");
  assert.equal(agentCalls, 0);
  await bot.handleUpdate(message("/nuova", 0));
  assert(
    calls.some((c) =>
      (JSON.stringify(c.payload.reply_markup) ?? "").includes("nt_create")
    ),
    "New-topic picker must offer folder creation"
  );
  await bot.handleUpdate(message("/nuovo_progetto demo-created", 0));
  assert(
    existsSync(join(root, "demo-created")),
    "New project must create its folder"
  );
  assert(
    calls.some((c) =>
      (JSON.stringify(c.payload.reply_markup) ?? "").includes(
        "nt_provider:demo-created:claude"
      )
    )
  );
  writeFileSync(join(root, "demo-created", "keep.txt"), "original");
  await bot.handleUpdate(message("/nuovo_progetto demo-created", 0));
  assert.equal(
    readFileSync(join(root, "demo-created", "keep.txt"), "utf8"),
    "original"
  );
  await bot.handleUpdate(message("/nuovo_progetto forbidden", 0, 99));
  assert(!existsSync(join(root, "forbidden")));
  await bot.handleUpdate(
    message("/nuovo_progetto forbidden-group", 0, 42, -999)
  );
  assert(!existsSync(join(root, "forbidden-group")));
  await bot.handleUpdate(message("/nuova", 0));
  assert(
    calls.some((c) =>
      (JSON.stringify(c.payload.reply_markup) ?? "").includes(
        "nt_project:demo-created"
      )
    )
  );
  const chooseProvider = callback(0);
  if (chooseProvider.callback_query) {
    chooseProvider.callback_query.data = "nt_provider:demo-created:claude";
  }
  await bot.handleUpdate(chooseProvider);
  const storedTopics = JSON.parse(
    readFileSync(join(root, ".data", "topics.json"), "utf8")
  );
  assert.equal(
    storedTopics.topics["t:-100:55"].activeProject,
    join(root, "demo-created")
  );
  assert.equal(storedTopics.topics["t:-100:55"].activeProvider, "claude");
  const invalidProvider = callback(0);
  if (invalidProvider.callback_query) {
    invalidProvider.callback_query.data = "nt_provider:..:claude";
  }
  const topicsBeforeInvalid = calls.filter(
    (c) => c.method === "createForumTopic"
  ).length;
  await bot.handleUpdate(invalidProvider);
  assert.equal(
    calls.filter((c) => c.method === "createForumTopic").length,
    topicsBeforeInvalid
  );
  await bot.handleUpdate(message("/permessi chiedi"));
  assert.equal(operations.getSettings("t:-100:7").approvalPolicy, "ask");
  assert.equal(operations.getSettings("t:-100:8").approvalPolicy, "automatic");
  assert(
    calls.some(
      (c) =>
        c.method === "sendMessage" &&
        c.payload.message_thread_id === 7 &&
        String(c.payload.text).includes("aggiornati")
    )
  );
  await bot.handleUpdate(message("/permessi", 8));
  assert(String(calls.at(-1)?.payload.text).includes("automatici"));
  assert.equal(calls.at(-1)?.payload.message_thread_id, 8);
  await bot.handleUpdate(message("/permessi automatici", 7, 99));
  assert.equal(operations.getSettings("t:-100:7").approvalPolicy, "ask");
  await bot.handleUpdate(message("/permessi automatici", 7, 42, -999));
  assert.equal(operations.getSettings("t:-100:7").approvalPolicy, "ask");
  await bot.handleUpdate(message("/permessi chiedi", 0));
  assert.equal(operations.getSettings("c:-100").approvalPolicy, "automatic");
  for (const thread of [7, 8]) {
    await bot.handleUpdate(callback(thread));
    assert.equal(calls.at(-1)?.method, "answerCallbackQuery");
    assert(String(calls.at(-1)?.payload.text).includes("scaduta"));
  }
  const answeredBefore = calls.filter(
    (c) => c.method === "answerCallbackQuery"
  ).length;
  await bot.handleUpdate(callback(7, 99));
  await bot.handleUpdate(callback(7, 42, -999));
  await bot.handleUpdate(callback(0));
  assert.equal(
    calls.filter((c) => c.method === "answerCallbackQuery").length,
    answeredBefore
  );
  const callsBeforePrompt = calls.length;
  await bot.handleUpdate(message("Richiesta di verifica isolata"));
  assert(
    calls
      .slice(callsBeforePrompt)
      .some(
        (c) =>
          c.method === "sendMessage" &&
          c.payload.message_thread_id === 7 &&
          String(c.payload.text).includes("richiede approvazioni")
      )
  );
  assert.equal(agentCalls, 0);
  assert.equal(networkCalls, 0);
  await bot.handleUpdate(message("/permessi automatici"));
  const first = bot.handleUpdate(message("Prima richiesta controllata"));
  await firstStarted;
  await bot.handleUpdate(message("Seconda richiesta accodata"));
  assert(
    calls.some((c) =>
      String(c.payload.text).includes("Messaggio aggiunto alla coda")
    )
  );
  stopBotOperations(bot);
  releaseFirst();
  await first;
  await Bun.sleep(100);
  assert.deepEqual(agentPrompts, ["Prima richiesta controllata"]);
  assert.equal(networkCalls, 0);
  console.log("BOT_INTEGRATION_OK");
} finally {
  stopBotOperations(bot);
}
