import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { type SetupResult, setupInstallation } from "./setup";

interface Question {
  label: string;
  secret?: boolean;
}
type Prompt = (question: Question) => Promise<string | null>;

export async function runSetupWizard(options: {
  directory: string;
  defaultProjectsDir: string;
  dryRun?: boolean;
  prompt: Prompt;
}): Promise<SetupResult | null> {
  try {
    await lstat(join(resolve(options.directory), ".env"));
    throw new Error("Il file .env esiste già: configurazione conservata.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const questions: Question[] = [
    { label: "Token del nuovo bot Telegram (nascosto): ", secret: true },
    { label: "Il tuo ID utente Telegram numerico: " },
    {
      label: `Cartella assoluta dei progetti [${options.defaultProjectsDir}]: `,
    },
    {
      label: "Chiave Groq per i vocali (facoltativa, nascosta): ",
      secret: true,
    },
    {
      label:
        "ID gruppi autorizzati (facoltativi, negativi, separati da virgole): ",
    },
  ];
  const answers: string[] = [];
  for (const question of questions) {
    const answer = await options.prompt(question);
    if (answer === null) {
      return null;
    }
    answers.push(answer.trim());
  }
  const input = {
    directory: options.directory,
    token: answers[0] ?? "",
    userId: answers[1] ?? "",
    projectsDir: answers[2] || options.defaultProjectsDir,
    groqApiKey: answers[3],
    allowedChatIds: answers[4],
  };
  // Validate everything before confirmation; cancellation never creates files.
  const preview = await setupInstallation({ ...input, dryRun: true });
  if (options.dryRun) {
    return preview;
  }
  const confirmation = await options.prompt({
    label: `Creare ${preview.envPath} e la cartella ${preview.projectsDir}? [s/N]: `,
  });
  if (
    !(
      confirmation &&
      ["s", "si", "sì"].includes(confirmation.trim().toLowerCase())
    )
  ) {
    return null;
  }
  return setupInstallation(input);
}

/** Raw mode disables terminal echo before accepting any secret input. */
export function terminalPrompt(question: Question): Promise<string | null> {
  const input = process.stdin;
  const output = process.stdout;
  if (!(input.isTTY && output.isTTY)) {
    return Promise.reject(
      new Error(
        "La modalità interattiva richiede un terminale. Usare SETUP_* per l'automazione."
      )
    );
  }
  return new Promise((done) => {
    const wasRaw = input.isRaw;
    let answer = "";
    const finish = (value: string | null) => {
      input.off("keypress", onKey);
      input.off("end", onEnd);
      input.setRawMode(wasRaw);
      input.pause();
      output.write("\n");
      done(value);
    };
    const echo = (text: string) => {
      if (!question.secret) {
        output.write(text);
      }
    };
    const onEnd = () => finish(null);
    const onKey = (
      text: string | undefined,
      key: { name?: string; ctrl?: boolean; meta?: boolean }
    ) => {
      if (key.ctrl && (key.name === "c" || key.name === "d")) {
        finish(null);
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        finish(answer);
        return;
      }
      if (key.name === "backspace") {
        if (answer) {
          echo("\b \b");
        }
        answer = [...answer].slice(0, -1).join("");
        return;
      }
      if (
        !text ||
        key.ctrl ||
        key.meta ||
        [...text].some(
          (char) => char < " " || char === String.fromCharCode(127)
        )
      ) {
        return;
      }
      answer += text;
      echo(text);
    };
    input.setRawMode(true);
    emitKeypressEvents(input);
    input.on("keypress", onKey);
    input.once("end", onEnd);
    output.write(question.label);
    input.resume();
  });
}
