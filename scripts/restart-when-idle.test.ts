import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupExists,
  type RestartDependencies,
  type RestartReceipt,
  readProcessChildren,
  restartWhenIdle,
} from "./restart-when-idle";

const options = {
  expectedPid: 1234,
  expectedCommit: "a".repeat(40),
  backup: "/backups/bot.tar",
};
function fixture() {
  let now = Date.parse("2026-09-14T10:00:00Z");
  let restarted = false;
  const calls: string[][] = [];
  const receipts: RestartReceipt[] = [];
  const deps: RestartDependencies = {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    children: async () => [],
    backupExists: async () => true,
    writeReceipt: async (receipt) => {
      receipts.push(receipt);
    },
    command: async (args) => {
      calls.push(args);
      if (args.includes("restart")) {
        restarted = true;
        return { code: 0, stdout: "" };
      }
      if (args.includes("show")) {
        return { code: 0, stdout: restarted ? "5678" : "1234" };
      }
      if (args.includes("rev-parse")) {
        return { code: 0, stdout: options.expectedCommit };
      }
      if (args.includes("status")) {
        return { code: 0, stdout: "" };
      }
      if (args.includes("is-active")) {
        return { code: 0, stdout: "active" };
      }
      if (args[0] === "journalctl") {
        return {
          code: 0,
          stdout: `Bot started revision ${options.expectedCommit.slice(0, 12)}\n`,
        };
      }
      throw new Error("Comando inatteso");
    },
  };
  return { deps, calls, receipts };
}

test("restarts once only after two idle samples five seconds apart and records startup", async () => {
  const f = fixture();
  const sampled: number[] = [];
  let busy = true;
  f.deps.children = async () => {
    sampled.push(f.deps.now());
    if (busy) {
      busy = false;
      return [99];
    }
    return [];
  };
  const receipt = await restartWhenIdle(options, f.deps);
  expect(receipt.status).toBe("success");
  expect(receipt.mainPid).toBe(5678);
  expect((sampled[2] ?? 0) - (sampled[1] ?? 0)).toBeGreaterThanOrEqual(5000);
  expect(f.calls.filter((args) => args.includes("restart"))).toHaveLength(1);
  expect(f.receipts).toEqual([receipt]);
});

test("never restarts if expected PID, commit, working tree or backup changed", async () => {
  for (const kind of ["pid", "head", "dirty", "backup"]) {
    const f = fixture();
    const command = f.deps.command;
    f.deps.command = (args) => {
      if (kind === "pid" && args.includes("show")) {
        return Promise.resolve({ code: 0, stdout: "9999" });
      }
      if (kind === "head" && args.includes("rev-parse")) {
        return Promise.resolve({ code: 0, stdout: "b".repeat(40) });
      }
      if (kind === "dirty" && args.includes("status")) {
        return Promise.resolve({ code: 0, stdout: " M src/bot.ts" });
      }
      return command(args);
    };
    if (kind === "backup") {
      f.deps.backupExists = async () => false;
    }
    const receipt = await restartWhenIdle(options, f.deps);
    expect(receipt.status).toBe("failed");
    expect(f.calls.some((args) => args.includes("restart"))).toBe(false);
  }
});

test("busy process reaches deadline without restarting", async () => {
  const f = fixture();
  const start = f.deps.now();
  f.deps.children = async () => [99];
  const receipt = await restartWhenIdle(options, f.deps);
  expect(receipt.status).toBe("failed");
  expect(f.deps.now() - start).toBeGreaterThanOrEqual(30 * 60_000);
  expect(f.calls.some((args) => args.includes("restart"))).toBe(false);
});

test("missing revision marker fails verification after one restart", async () => {
  const f = fixture();
  const command = f.deps.command;
  f.deps.command = (args) =>
    args[0] === "journalctl"
      ? Promise.resolve({ code: 0, stdout: "" })
      : command(args);
  const receipt = await restartWhenIdle(options, f.deps);
  expect(receipt.status).toBe("failed");
  expect(f.calls.filter((args) => args.includes("restart"))).toHaveLength(1);
  expect(receipt.reason).toContain("avvio");
});

test("rejects invalid inputs without any command", async () => {
  const f = fixture();
  await expect(
    restartWhenIdle({ ...options, expectedCommit: "abc" }, f.deps)
  ).rejects.toThrow();
  await expect(
    restartWhenIdle({ ...options, backup: "relative" }, f.deps)
  ).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});

test("children of all Bun threads are included and read failures fail closed", async () => {
  const files = {
    tasks: async () => ["1234", "1235"],
    children: async (path: string) =>
      path.includes("/1235/") ? "888 999" : "888",
  };
  expect(await readProcessChildren(1234, files)).toEqual([888, 999]);
  await expect(
    readProcessChildren(1234, {
      ...files,
      children: async () => {
        throw new Error("access denied");
      },
    })
  ).rejects.toThrow();
});

test("deadline crossed during final checks prevents the restart", async () => {
  const f = fixture();
  const command = f.deps.command;
  let heads = 0;
  f.deps.command = async (args) => {
    if (args.includes("rev-parse") && ++heads === 2) {
      await f.deps.sleep(30 * 60_000);
    }
    return command(args);
  };
  expect((await restartWhenIdle(options, f.deps)).status).toBe("failed");
  expect(f.calls.some((args) => args.includes("restart"))).toBe(false);
});

test("journal since uses the systemd epoch timestamp format", async () => {
  const f = fixture();
  await restartWhenIdle(options, f.deps);
  const args = f.calls.find((call) => call[0] === "journalctl") ?? [];
  expect(args[args.indexOf("--since") + 1]).toBe("@1789380005");
});

test("backup must be a non-empty regular file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "restart-backup-"));
  try {
    const path = join(directory, "backup.tar");
    expect(await backupExists(directory)).toBe(false);
    await writeFile(path, "");
    expect(await backupExists(path)).toBe(false);
    await writeFile(path, "backup");
    expect(await backupExists(path)).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
