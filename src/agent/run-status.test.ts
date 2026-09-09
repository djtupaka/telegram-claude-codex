import { expect, test } from "bun:test";
import { formatActiveRunTiming } from "./run-status";

test("formats elapsed runtime and last-progress age without inferring failure", () => {
  expect(
    formatActiveRunTiming(
      {
        provider: "codex",
        runId: "run-1",
        startedAt: 0,
        lastProgressAt: 39 * 60 * 1000 + 2000,
      },
      42 * 60 * 1000 + 10_000
    )
  ).toBe("Yes (codex, 42m 10s)\nLast progress: 3m 08s ago");
});
