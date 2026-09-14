import type { Context, Transformer } from "grammy";

/**
 * Where an update comes from, and therefore which independent session state,
 * run key and session key apply:
 * - private: the authorized user's private chat (legacy behaviour, global state)
 * - topic:   a forum topic inside an allowed group (one session per topic)
 * - control: the "General" area of an allowed group (only /nuova, /elenco, help)
 * - denied:  any other non-private chat (ignored)
 */
export type ScopeKind = "private" | "topic" | "control" | "denied";

export interface Scope {
  chatId: number;
  key: string;
  kind: ScopeKind;
  threadId?: number;
  userId: number;
}

export const privateKey = (userId: number) => `u:${userId}`;
export const topicKey = (chatId: number, threadId: number) =>
  `t:${chatId}:${threadId}`;
export const controlKey = (chatId: number) => `c:${chatId}`;

/** Minimal shape of a grammY context needed to resolve the scope (testable). */
export interface ScopeSource {
  chat?: { id: number; type: string };
  from?: { id: number };
  msg?: { is_topic_message?: boolean; message_thread_id?: number };
}

export function resolveScope(
  ctx: ScopeSource,
  allowedChatIds: ReadonlySet<number>
): Scope | undefined {
  const chat = ctx.chat;
  const userId = ctx.from?.id;
  if (!chat || userId === undefined) {
    return undefined;
  }
  if (chat.type === "private") {
    return {
      kind: "private",
      key: privateKey(userId),
      chatId: chat.id,
      userId,
    };
  }
  if (chat.type !== "group" && chat.type !== "supergroup") {
    return { kind: "denied", key: "", chatId: chat.id, userId };
  }
  if (!allowedChatIds.has(chat.id)) {
    return { kind: "denied", key: "", chatId: chat.id, userId };
  }
  const threadId = ctx.msg?.message_thread_id;
  if (ctx.msg?.is_topic_message && threadId !== undefined) {
    return {
      kind: "topic",
      key: topicKey(chat.id, threadId),
      chatId: chat.id,
      threadId,
      userId,
    };
  }
  return { kind: "control", key: controlKey(chat.id), chatId: chat.id, userId };
}

/** Bot API methods whose payload must carry the topic id to land in the topic. */
const THREAD_METHOD_RE = /^(send|copy|forward)/;

/**
 * Context-scoped transformer: every outgoing send/copy/forward made through
 * this context's `api` targets the topic, unless the caller already set a
 * thread id. grammY builds a fresh Api per update, so this never leaks.
 */
export const threadTransformer =
  (chatId: number, threadId: number): Transformer =>
  (prev, method, payload, signal) => {
    if (
      THREAD_METHOD_RE.test(method) &&
      payload &&
      typeof payload === "object" &&
      !("message_thread_id" in payload) &&
      (payload as { chat_id?: unknown }).chat_id === chatId
    ) {
      return prev(method, { ...payload, message_thread_id: threadId }, signal);
    }
    return prev(method, payload, signal);
  };

export function installThreadTransformer(ctx: Context, scope: Scope) {
  if (scope.kind === "topic" && scope.threadId !== undefined) {
    ctx.api.config.use(threadTransformer(scope.chatId, scope.threadId));
  }
}

/**
 * Session-store key: private chats keep the plain project path (backward
 * compatible); topics get a topic-suffixed key so two scopes on the same
 * project never resume each other's conversation.
 */
export const sessionProjectKey = (
  scopeKey: string | undefined,
  project: string
) => (scopeKey ? `${project}#${scopeKey}` : project);
