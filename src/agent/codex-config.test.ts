import { describe, expect, test } from "bun:test";
import {
  codexThreadOverrides,
  formatCodexStatus,
  readCodexRuntimeConfig,
} from "./codex-config";

describe("codex runtime configuration", () => {
  test("uses and displays explicit model and effort", () => {
    const env = {
      CODEX_MODEL: "gpt-5.6-sol",
      CODEX_REASONING_EFFORT: "medium",
    };

    expect(readCodexRuntimeConfig(env)).toEqual({
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
    });
    expect(codexThreadOverrides(env)).toEqual({
      model: "gpt-5.6-sol",
      modelReasoningEffort: "medium",
    });
    expect(formatCodexStatus(env)).toBe("Modello: gpt-5.6-sol\nEffort: medium");
  });

  test("labels missing or blank values as inherited", () => {
    expect(formatCodexStatus({})).toBe("Modello: ereditato\nEffort: ereditato");
    expect(
      formatCodexStatus({ CODEX_MODEL: "  ", CODEX_REASONING_EFFORT: "" })
    ).toBe("Modello: ereditato\nEffort: ereditato");
    expect(codexThreadOverrides({})).toEqual({});
  });
});
