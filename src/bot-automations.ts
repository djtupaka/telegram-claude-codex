import type { Bot, Context } from "grammy";
import {
  type AutomationStore,
  type AutomationTarget,
  type EventSource,
  makeAutomationScheduler,
  makeAutomationStore,
  nextScheduledTime,
  type Schedule,
} from "./automations";
import { makeEventIngress } from "./event-ingress";

const PROGRAM_PATTERN = /^(giornaliero|una)\s+(\S+)\s+([\s\S]+)$/;
const EVENT_PATTERN = /^(coolify|truenas|tdarr)\s+(on|off|stato)$/;
const PROGRAM_USAGE =
  "Uso: /programma giornaliero HH:MM testo oppure /programma una ISO testo (ISO con fuso orario).";
export function parseProgramCommand(text: string): {
  schedule: Schedule;
  prompt: string;
} {
  const match = PROGRAM_PATTERN.exec(text.trim());
  if (!(match?.[2] && match[3]?.trim())) {
    throw new Error(PROGRAM_USAGE);
  }
  const schedule: Schedule =
    match[1] === "giornaliero"
      ? { kind: "daily", time: match[2], timezone: "Europe/Rome" }
      : { kind: "once", at: match[2] };
  nextScheduledTime(schedule, Date.now());
  return { schedule, prompt: match[3].trim() };
}
export interface InstallAutomationsOptions {
  bot: Bot;
  eventsPort?: number;
  eventsToken?: string;
  getTarget: (ctx: Context) => AutomationTarget;
  isBusy: (scopeKey: string) => boolean;
  run: (
    target: AutomationTarget,
    prompt: string,
    signal: AbortSignal,
    readOnly: boolean
  ) => Promise<void>;
  store?: AutomationStore;
  validateTarget: (target: AutomationTarget) => void;
}
/** Installs authorized commands only; networking and timers begin exclusively at start(). */
export function installAutomations(options: InstallAutomationsOptions) {
  if (
    options.eventsPort !== undefined &&
    (!Number.isInteger(options.eventsPort) ||
      options.eventsPort < 1 ||
      options.eventsPort > 65_535)
  ) {
    throw new Error("Porta eventi non valida");
  }
  if (
    options.eventsPort !== undefined &&
    (!options.eventsToken || options.eventsToken.trim().length < 32)
  ) {
    throw new Error("Il token eventi deve contenere almeno 32 caratteri");
  }
  const store = options.store ?? makeAutomationStore();
  const send = (target: AutomationTarget, text: string) => {
    options.validateTarget(target);
    return options.bot.api.sendMessage(target.chatId, text, {
      message_thread_id: target.threadId,
    });
  };
  const scheduler = makeAutomationScheduler({
    store,
    isBusy: options.isBusy,
    onError: () => {
      console.error(
        "Automazione non riuscita; consultare lo stato dei programmi."
      );
    },
    run: async (job, signal) => {
      try {
        options.validateTarget(job);
        await options.run(job, job.prompt, signal, false);
      } catch (error) {
        await send(
          job,
          `Il programma ${job.id} è terminato con un errore. Usa /programmi per verificarne lo stato.`
        );
        throw error;
      }
    },
  });
  const guarded =
    (
      handler: (
        ctx: Context,
        target: AutomationTarget,
        text: string
      ) => Promise<void>
    ) =>
    async (ctx: Context) => {
      try {
        const target = options.getTarget(ctx);
        await handler(
          ctx,
          target,
          typeof ctx.match === "string" ? ctx.match.trim() : ""
        );
      } catch (error) {
        await ctx.reply(
          error instanceof Error ? error.message : "Operazione non riuscita."
        );
      }
    };
  options.bot.command(
    "programma",
    guarded(async (ctx, target, text) => {
      const input = parseProgramCommand(text);
      const job = store.add({ ...target, ...input });
      await ctx.reply(
        `Programma creato: ${job.id}\nProssima esecuzione: ${job.nextRunAt}\nProgetto: ${job.project}\nProvider: ${job.provider}`
      );
    })
  );
  options.bot.command(
    "programmi",
    guarded(async (ctx, target) => {
      const jobs = store.list(target.scopeKey);
      if (!jobs.length) {
        await ctx.reply("Nessun programma in questo topic.");
        return;
      }
      for (const job of jobs) {
        const status = job.lastResult
          ? {
              running: "in esecuzione",
              success: "riuscito",
              error: "errore",
              cancelled: "annullato",
            }[job.lastResult]
          : "in attesa";
        await ctx.reply(
          `${job.id}\n${job.prompt.slice(0, 500)}\n${job.completed ? "Concluso" : `Prossima esecuzione: ${job.nextRunAt}`}\nStato: ${status}\nProgetto: ${job.project}\nProvider: ${job.provider}${job.lastError ? "\nErrore: esecuzione non riuscita." : ""}`
        );
      }
    })
  );
  options.bot.command(
    "annulla_programma",
    guarded(async (ctx, target, text) => {
      if (!text) {
        throw new Error("Uso: /annulla_programma id");
      }
      await ctx.reply(
        store.cancel(target.scopeKey, text)
          ? "Programma annullato."
          : "Programma non trovato in questo topic."
      );
    })
  );
  options.bot.command(
    "eventi",
    guarded(async (ctx, target, text) => {
      const match = EVENT_PATTERN.exec(text);
      if (!match?.[1]) {
        throw new Error("Uso: /eventi coolify|truenas|tdarr on|off|stato");
      }
      const source = match[1] as EventSource;
      if (match[2] === "off") {
        store.unsubscribe(target.scopeKey, source);
        await ctx.reply(`Notifiche ${source} disattivate per questo topic.`);
        return;
      }
      if (match[2] === "on") {
        store.subscribe({ ...target, source });
      }
      const active = store
        .subscriptions(source)
        .some((s) => s.scopeKey === target.scopeKey);
      await ctx.reply(
        `Notifiche ${source}: ${active ? "attive" : "disattivate"}.\nRicevitore HTTP: ${options.eventsPort === undefined ? "non configurato" : "configurato su localhost"}.${active && target.provider === "codex" ? "\nCon Codex gli eventi vengono notificati senza avviare diagnosi automatiche." : ""}`
      );
    })
  );
  let server: ReturnType<typeof Bun.serve> | undefined;
  let ingress: ReturnType<typeof makeEventIngress> | undefined;
  let started = false;
  return {
    start: () => {
      if (started) {
        return;
      }
      if (options.eventsPort !== undefined) {
        ingress = makeEventIngress({
          token: options.eventsToken ?? "",
          store,
          isBusy: options.isBusy,
          diagnose: async (target, prompt, signal) => {
            if (target.provider === "codex") {
              await send(
                target,
                `Notifica di servizio (dati esterni non attendibili). Diagnosi automatica non avviata per Codex.\n${prompt.slice(0, 3300)}`
              );
              return;
            }
            try {
              options.validateTarget(target);
              await options.run(target, prompt, signal, true);
            } catch (error) {
              await send(
                target,
                "La prima diagnosi non è riuscita. Richiedi una verifica manuale nel topic."
              );
              throw error;
            }
          },
          onError: () => {
            console.error(
              "Evento non elaborato: diagnosi o destinazione non disponibile."
            );
          },
        });
        try {
          server = Bun.serve({
            hostname: "127.0.0.1",
            port: options.eventsPort,
            maxRequestBodySize: 32_768,
            idleTimeout: 10,
            fetch: ingress.fetch,
          });
        } catch (error) {
          ingress.close();
          ingress = undefined;
          throw error;
        }
      }
      scheduler.start();
      started = true;
    },
    stop: () => {
      scheduler.stop();
      ingress?.close();
      server?.stop(true);
      server = undefined;
      ingress = undefined;
      started = false;
    },
  };
}
