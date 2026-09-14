import type { ActiveRunSnapshot } from "./types";

const formatDuration = (durationMs: number) => {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}m ${seconds.toString().padStart(2, "0")}s`
    : `${seconds}s`;
};

/** Render active-run timing without diagnosing the run as hung or failed. */
export const formatActiveRunTiming = (
  run: ActiveRunSnapshot,
  now = Date.now()
) =>
  `Sì (${run.provider === "claude" ? "Claude Code" : "Codex"}, ${formatDuration(now - run.startedAt)})\nUltimo aggiornamento: ${formatDuration(now - run.lastProgressAt)} fa`;
