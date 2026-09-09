import { expect, test } from "bun:test";
import { claudeProvider } from "./claude";
import { codexProvider } from "./codex";
import { resolveEffortChoice, resolveModelChoice } from "./preferences";

test("Codex defaults to Astra medium while preserving Sol as a choice", () => {
  expect(codexProvider.defaultModel).toBe("gpt-6-astra");
  expect(codexProvider.defaultEffort).toBe("medium");
  expect(codexProvider.models.map(({ id }) => id)).toContain("gpt-5.6-sol");
  expect(codexProvider.effortLevels.map(({ id }) => id)).toEqual([
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
});

test("provider choices resolve missing and default values to provider defaults", () => {
  expect(resolveModelChoice(codexProvider)).toBe("gpt-6-astra");
  expect(resolveModelChoice(codexProvider, "default")).toBe("gpt-6-astra");
  expect(resolveEffortChoice(codexProvider)).toBe("medium");
  expect(resolveEffortChoice(codexProvider, "default")).toBe("medium");
});

test("provider choices preserve explicit values", () => {
  expect(resolveModelChoice(codexProvider, "gpt-5.6-sol")).toBe("gpt-5.6-sol");
  expect(resolveEffortChoice(codexProvider, "high")).toBe("high");
});

test("Claude defaults to Fable 5.1 and exposes only the current compact catalog", () => {
  expect(claudeProvider.defaultModel).toBe("claude-fable-5-1");
  expect(claudeProvider.models.map(({ id }) => id)).toEqual([
    "default",
    "claude-fable-5-1",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-haiku-4-5-20251001",
  ]);
  expect(claudeProvider.effortLevels.map(({ id }) => id)).toEqual([
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
});
