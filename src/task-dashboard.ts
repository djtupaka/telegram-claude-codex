import { InlineKeyboard } from "grammy";
import { topicLink } from "./dev-menu";

export interface DashboardTask {
  automatic?: boolean;
  chatId: number;
  lastProgressAt?: number;
  project: string;
  prompt?: string;
  provider: string;
  queued: string[];
  running: boolean;
  startedAt?: number;
  threadId?: number;
  waitingForPlan?: boolean;
}
const PAGE_SIZE = 5;
const preview = (value: string, length = 100) => {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > length ? `${line.slice(0, length)}…` : line;
};
const elapsed = (since: number, now: number) => {
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min`;
};
function taskLines(task: DashboardTask, number: number, now: number) {
  const state = task.running ? "In esecuzione" : "In attesa";
  const lines = [
    `${number}. ${preview(task.project, 60)} · ${task.provider}`,
    `${state}${task.automatic ? " · programmato" : ""}${task.startedAt === undefined ? "" : ` da ${elapsed(task.startedAt, now)}`}`,
  ];
  if (task.lastProgressAt !== undefined) {
    lines.push(`Ultimo aggiornamento: ${elapsed(task.lastProgressAt, now)} fa`);
  }
  if (task.prompt) {
    lines.push(`Richiesta: ${preview(task.prompt)}`);
  }
  if (task.waitingForPlan) {
    lines.push("Piano in attesa di una scelta.");
  }
  lines.push(`In coda: ${task.queued.length}`);
  lines.push(
    ...task.queued
      .slice(0, 3)
      .map((text, index) => `  ${index + 1}) ${preview(text)}`)
  );
  if (task.queued.length > 3) {
    lines.push(`  …e altri ${task.queued.length - 3} messaggi`);
  }
  return lines.join("\n");
}
/** Group panels never disclose work from another group or the private chat. */
export function buildTaskDashboard(
  tasks: DashboardTask[],
  chatId: number,
  page = 0,
  now = Date.now()
) {
  const visible = tasks.filter(
    (task) =>
      task.chatId === chatId &&
      (task.running || task.queued.length > 0 || task.waitingForPlan)
  );
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const current = Math.max(
    0,
    Math.min(Number.isSafeInteger(page) ? page : 0, pages - 1)
  );
  const shown = visible.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const keyboard = new InlineKeyboard();
  for (const [index, task] of shown.entries()) {
    const link =
      task.threadId === undefined
        ? undefined
        : topicLink(task.chatId, task.threadId);
    if (link) {
      keyboard
        .url(
          `${current * PAGE_SIZE + index + 1}. ${preview(task.project, 40)}`,
          link
        )
        .row();
    }
  }
  if (current > 0) {
    keyboard.text("← Precedenti", `jobs:${current - 1}`);
  }
  if (current < pages - 1) {
    keyboard.text("Successivi →", `jobs:${current + 1}`);
  }
  keyboard
    .row()
    .text("🔄 Aggiorna", `jobs:${current}`)
    .text("↩ Menu", "menu:open");
  const text = [
    `Lavori · ${visible.length} conversazioni · pagina ${current + 1}/${pages}`,
    ...shown.map((task, index) =>
      taskLines(task, current * PAGE_SIZE + index + 1, now)
    ),
    ...(visible.length
      ? []
      : ["Nessun lavoro in corso o in coda in questa chat."]),
  ].join("\n\n");
  return { text, keyboard };
}
