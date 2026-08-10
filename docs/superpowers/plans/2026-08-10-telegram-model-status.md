# Telegram Model Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mostrare in `/status` il modello Codex e il reasoning effort esplicitamente configurati per il bot, senza inventare i valori ereditati.

**Architecture:** Una funzione pura in `src/agent/codex-config.ts` legge e normalizza `CODEX_MODEL` e `CODEX_REASONING_EFFORT`; la stessa funzione produce gli override del thread e le due righe mostrate da Telegram. `src/agent/codex.ts` e `src/bot.ts` consumano quindi un'unica fonte di verità.

**Tech Stack:** Bun, TypeScript, Grammy, OpenAI Codex SDK, `bun test`.

## Global Constraints

- Default operativo esterno al codice: `gpt-5.6-sol` con effort `medium`.
- Se modello o effort non sono esplicitamente configurati, `/status` mostra `ereditato`.
- Nessun comando Telegram modifica modello o effort durante una sessione.
- Le modifiche non consolidate già presenti in `bun.lock`, `package.json`, `src/agent/codex.ts` e `src/bot.ts` devono essere preservate.
- Il provider Claude non mostra valori Codex.

---

### Task 1: Configurazione Codex condivisa e stato Telegram

**Files:**
- Create: `src/agent/codex-config.ts`
- Create: `src/agent/codex-config.test.ts`
- Modify: `src/agent/codex.ts:278-291`
- Modify: `src/bot.ts:1-25,630-651`

**Interfaces:**
- Produces: `readCodexRuntimeConfig(env?: NodeJS.ProcessEnv): CodexRuntimeConfig`
- Produces: `codexThreadOverrides(env?: NodeJS.ProcessEnv): Partial<Pick<ThreadOptions, "model" | "modelReasoningEffort">>`
- Produces: `formatCodexStatus(env?: NodeJS.ProcessEnv): string`
- Consumes: `CODEX_MODEL` e `CODEX_REASONING_EFFORT` dall'ambiente del bot.

- [ ] **Step 1: Scrivere i test inizialmente rossi**

```ts
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
    expect(formatCodexStatus(env)).toBe(
      "Modello: gpt-5.6-sol\nEffort: medium"
    );
  });

  test("labels missing or blank values as inherited", () => {
    expect(formatCodexStatus({})).toBe(
      "Modello: ereditato\nEffort: ereditato"
    );
    expect(
      formatCodexStatus({ CODEX_MODEL: "  ", CODEX_REASONING_EFFORT: "" })
    ).toBe("Modello: ereditato\nEffort: ereditato");
    expect(codexThreadOverrides({})).toEqual({});
  });
});
```

- [ ] **Step 2: Eseguire il test e verificare il rosso corretto**

Run: `bun test src/agent/codex-config.test.ts`

Expected: FAIL perché `src/agent/codex-config.ts` non esiste ancora.

- [ ] **Step 3: Implementare la funzione pura condivisa**

```ts
import type { ThreadOptions } from "@openai/codex-sdk";

export interface CodexRuntimeConfig {
  model?: string;
  reasoningEffort?: ThreadOptions["modelReasoningEffort"];
}

const normalized = (value: string | undefined) => {
  const result = value?.trim();
  return result ? result : undefined;
};

export const readCodexRuntimeConfig = (
  env: NodeJS.ProcessEnv = process.env
): CodexRuntimeConfig => ({
  model: normalized(env.CODEX_MODEL),
  reasoningEffort: normalized(
    env.CODEX_REASONING_EFFORT
  ) as ThreadOptions["modelReasoningEffort"] | undefined,
});

export const codexThreadOverrides = (
  env: NodeJS.ProcessEnv = process.env
): Partial<Pick<ThreadOptions, "model" | "modelReasoningEffort">> => {
  const config = readCodexRuntimeConfig(env);
  return {
    ...(config.model ? { model: config.model } : {}),
    ...(config.reasoningEffort
      ? { modelReasoningEffort: config.reasoningEffort }
      : {}),
  };
};

export const formatCodexStatus = (
  env: NodeJS.ProcessEnv = process.env
) => {
  const config = readCodexRuntimeConfig(env);
  return [
    `Modello: ${config.model ?? "ereditato"}`,
    `Effort: ${config.reasoningEffort ?? "ereditato"}`,
  ].join("\n");
};
```

- [ ] **Step 4: Collegare il thread Codex alla funzione condivisa**

In `src/agent/codex.ts`, importare `codexThreadOverrides` e sostituire gli spread diretti di `process.env` con:

```ts
  ...codexThreadOverrides(),
```

Il resto delle modifiche non consolidate nel file resta invariato.

- [ ] **Step 5: Mostrare i valori soltanto nello stato Codex**

In `src/bot.ts`, importare `formatCodexStatus` e costruire:

```ts
    const codexConfigLine =
      state.activeProvider === "codex" ? `\n${formatCodexStatus()}` : "";
```

Inserire `codexConfigLine` immediatamente dopo la riga `Provider` nella risposta di `/status`. Il provider Claude continua a produrre lo stato precedente.

- [ ] **Step 6: Eseguire test mirato e suite completa**

Run: `bun test src/agent/codex-config.test.ts`

Expected: PASS per entrambi i casi.

Run: `bun test`

Expected: tutti i test PASS.

Run: `bun run typecheck && bun run lint`

Expected: typecheck e lint completati senza errori.

- [ ] **Step 7: Controllare differenze e commit mirato**

Run: `git diff --check`

Expected: nessun errore di whitespace.

Stage soltanto `src/agent/codex-config.ts`, `src/agent/codex-config.test.ts` e gli hunk relativi di `src/agent/codex.ts` e `src/bot.ts`; non includere gli aggiornamenti SDK, lockfile o upload staging non pertinenti.

```bash
git commit -m "feat: show Codex model in Telegram status"
```

- [ ] **Step 8: Riavvio controllato e verifica Telegram**

Run: `bun run service:status`

Expected: identificazione del metodo di esecuzione effettivo senza modifiche.

Riavviare esclusivamente il servizio del bot con il relativo comando già supportato dal repository. Verificare dai log che il bot riparta senza errori e inviare `/status` per confermare:

```text
Provider: OpenAI Codex
Modello: gpt-5.6-sol
Effort: medium
```

Non modificare PremelOne e non eseguire deploy Coolify.
