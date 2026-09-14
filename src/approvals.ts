import { randomBytes } from "node:crypto";

export interface ToolApprovalRequest {
  input: Record<string, unknown>;
  signal: AbortSignal;
  toolName: string;
  toolUseId: string;
}

export interface ApprovalScope {
  chatId: number;
  runId: string;
  runKey: string;
  threadId?: number;
  userId: number;
}

export interface ApprovalPrompt {
  id: string;
  replyMarkup: {
    inline_keyboard: { text: string; callback_data: string }[][];
  };
  text: string;
}

interface PendingApproval {
  approvable: boolean;
  finish: (allowed: boolean) => void;
  scope: ApprovalScope;
}

const CALLBACK_PATTERN = /^approval:([a-f0-9]{32}):(allow|deny)$/;

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/** Memory-only, single-tool approvals. Restart, disconnect and cancellation fail closed. */
export class ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly timeoutMs: number;

  constructor(timeoutMs = 120_000) {
    this.timeoutMs = timeoutMs;
  }

  request(
    scope: ApprovalScope,
    request: ToolApprovalRequest,
    publish: (prompt: ApprovalPrompt) => Promise<void>
  ): Promise<boolean> {
    if (request.signal.aborted) {
      return Promise.resolve(false);
    }
    let input: string;
    try {
      input = escapeHtml(JSON.stringify(request.input, null, 2));
    } catch {
      return Promise.resolve(false);
    }
    const name = escapeHtml(request.toolName);
    const approvable = input.length + name.length <= 3000;
    const id = randomBytes(16).toString("hex");
    const buttons = approvable
      ? [{ text: "Approva una volta", callback_data: `approval:${id}:allow` }]
      : [];
    buttons.push({ text: "Rifiuta", callback_data: `approval:${id}:deny` });
    const prompt: ApprovalPrompt = {
      id,
      text: `<b>Autorizzazione richiesta: ${name.slice(0, 100)}</b>\n<pre>${input.slice(0, 3000)}</pre>${approvable ? "\nValida soltanto per questa chiamata." : "\nInput troppo lungo: approvazione disabilitata. Richiedere un'operazione più piccola."}`,
      replyMarkup: { inline_keyboard: [buttons] },
    };
    return new Promise<boolean>((resolve) => {
      const finish = (allowed: boolean) => {
        if (!this.pending.delete(id)) {
          return;
        }
        clearTimeout(timer);
        request.signal.removeEventListener("abort", abort);
        resolve(allowed);
      };
      const abort = () => finish(false);
      const timer = setTimeout(abort, this.timeoutMs);
      this.pending.set(id, { scope: { ...scope }, approvable, finish });
      request.signal.addEventListener("abort", abort, { once: true });
      try {
        publish(prompt).catch(abort);
      } catch {
        abort();
      }
    });
  }

  resolve(data: string, scope: ApprovalScope): boolean {
    const match = CALLBACK_PATTERN.exec(data);
    if (!match) {
      return false;
    }
    const pending = this.pending.get(match[1] ?? "");
    if (
      !pending ||
      pending.scope.userId !== scope.userId ||
      pending.scope.chatId !== scope.chatId ||
      pending.scope.threadId !== scope.threadId ||
      pending.scope.runId !== scope.runId ||
      pending.scope.runKey !== scope.runKey
    ) {
      return false;
    }
    pending.finish(match[2] === "allow" && pending.approvable);
    return true;
  }

  cancelRun(runId: string): void {
    for (const pending of this.pending.values()) {
      if (pending.scope.runId === runId) {
        pending.finish(false);
      }
    }
  }

  cancelAll(): void {
    for (const pending of this.pending.values()) {
      pending.finish(false);
    }
  }
}
