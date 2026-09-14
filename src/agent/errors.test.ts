import { describe, expect, test } from "bun:test";
import {
  AgentInterrupted,
  AgentTimedOut,
  AtCapacity,
  classifyOutcome,
  ProcessFailed,
  ProviderCrashed,
} from "./errors";

describe("classifyOutcome", () => {
  test("interrupt -> Esecuzione interrotta.", () => {
    expect(
      classifyOutcome(new AgentInterrupted({ reason: "stopped" }))
    ).toEqual({
      outcome: "interrupted",
      copy: "Esecuzione interrotta.",
    });
    expect(
      classifyOutcome(new AgentInterrupted({ reason: "switched" })).copy
    ).toBe("Esecuzione interrotta.");
    expect(
      classifyOutcome(new AgentInterrupted({ reason: "new_prompt" })).copy
    ).toBe("Esecuzione interrotta.");
  });
  test("timeout -> interrupted/Tempo massimo di esecuzione superato.", () => {
    expect(classifyOutcome(new AgentTimedOut({}))).toEqual({
      outcome: "interrupted",
      copy: "Tempo massimo di esecuzione superato.",
    });
  });
  test("at_capacity", () => {
    expect(classifyOutcome(new AtCapacity({}))).toEqual({
      outcome: "at_capacity",
      copy: "Tutti gli agenti sono occupati. Riprova tra poco.",
    });
  });
  test("process failed uses stderr, falls back to exit code", () => {
    expect(
      classifyOutcome(new ProcessFailed({ code: 2, stderr: "  boom  " }))
    ).toEqual({
      outcome: "errored",
      copy: "boom",
    });
    expect(
      classifyOutcome(new ProcessFailed({ code: 2, stderr: "   " })).copy
    ).toBe("Processo terminato con errore (codice 2).");
  });
  test("provider crashed uses message", () => {
    expect(
      classifyOutcome(new ProviderCrashed({ message: "spawn ENOENT" }))
    ).toEqual({
      outcome: "errored",
      copy: "spawn ENOENT",
    });
  });
});
