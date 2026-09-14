import { expect, test } from "bun:test";
import { buildTaskDashboard, type DashboardTask } from "./task-dashboard";

const job: DashboardTask = {
  chatId: -100_123,
  threadId: 7,
  project: "Progetto",
  provider: "Codex",
  running: true,
  startedAt: 1000,
  prompt: "Controlla il PDF",
  queued: ["Secondo lavoro"],
};
test("dashboard shows timing, pending text and only this group's work", () => {
  const view = buildTaskDashboard(
    [job, { ...job, chatId: -100_999, project: "Segreto" }],
    -100_123,
    0,
    61_000
  );
  expect(view.text).toContain("1 min");
  expect(view.text).toContain("Controlla il PDF");
  expect(view.text).toContain("Secondo lavoro");
  expect(view.text).not.toContain("Segreto");
  expect(JSON.stringify(view.keyboard)).toContain("https://t.me/c/123/7");
});
test("dashboard paginates bounded previews and preserves queued-only work", () => {
  const jobs = Array.from({ length: 9 }, (_, i) => ({
    ...job,
    threadId: i + 2,
    project: `P${i}`,
    prompt: "x".repeat(10_000),
    queued: new Array(20).fill("y".repeat(10_000)),
  }));
  const view = buildTaskDashboard(jobs, -100_123, 0, 1000);
  expect(view.text.length).toBeLessThan(4000);
  expect(JSON.stringify(view.keyboard)).toContain("jobs:1");
  expect(
    buildTaskDashboard([{ ...job, running: false }], -100_123, 0).text
  ).toContain("In attesa");
  expect(buildTaskDashboard([], -100_123, 99).text).toContain("Nessun lavoro");
});
