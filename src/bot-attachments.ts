import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { type Bot, type Context, InlineKeyboard } from "grammy";
import {
  type AttachmentLocation,
  attachmentPurgeAvailability,
  type ManagedAttachment,
  purgeAttachment,
  scanAttachments,
  setAttachmentArchived,
} from "./attachment-manager";
export interface AttachmentContext extends AttachmentLocation {
  backupDir?: string;
  busy: boolean;
  scopeKey: string;
}
interface View {
  binding: string;
  entries: ManagedAttachment[];
  expires: number;
  pending?: number;
  purgePending?: number;
  summary: string;
}
interface AttachmentAction {
  ctx: Context;
  entry: ManagedAttachment;
  id: string;
  index: number;
  location: AttachmentContext;
  view: View;
}
const PAGE_SIZE = 6;
const bytes = (size: number) => `${(size / 1024 / 1024).toFixed(2)} MiB`;
const ATTACHMENT_CALLBACK = /^attachments:/;
const display = (text: string) =>
  [...text]
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 32 || (code >= 127 && code <= 159) ? " " : char;
    })
    .join("")
    .slice(0, 180);
export function installAttachmentManager(options: {
  bot: Bot;
  context: (ctx: Context) => AttachmentContext | undefined;
}) {
  const views = new Map<string, View>();
  const binding = (ctx: Context, location: AttachmentContext) =>
    JSON.stringify([
      ctx.from?.id,
      ctx.chat?.id,
      ctx.msg?.message_thread_id,
      location.scopeKey,
      location.projectPath,
      location.rootDir,
      location.backupDir,
      location.layout,
      location.legacyRootDir,
    ]);
  const clean = () => {
    for (const [id, view] of views) {
      if (view.expires < Date.now()) {
        views.delete(id);
      }
    }
    while (views.size >= 100) {
      const first = views.keys().next().value;
      if (!first) {
        break;
      }
      views.delete(first);
    }
  };
  async function showPage(
    ctx: Context,
    id: string,
    view: View,
    page: number,
    edit: boolean
  ) {
    const pages = Math.max(1, Math.ceil(view.entries.length / PAGE_SIZE));
    const selected = Math.min(Math.max(0, page), pages - 1);
    const keyboard = new InlineKeyboard();
    for (
      let i = selected * PAGE_SIZE;
      i < Math.min((selected + 1) * PAGE_SIZE, view.entries.length);
      i++
    ) {
      const entry = view.entries[i];
      if (!entry) {
        continue;
      }
      keyboard
        .text(
          `${entry.archived ? "📦 " : ""}${display(entry.record.originalName).slice(0, 45)}`,
          `attachments:${id}:detail:${i}`
        )
        .row();
    }
    if (selected > 0) {
      keyboard.text("←", `attachments:${id}:page:${selected - 1}`);
    }
    if (selected < pages - 1) {
      keyboard.text("→", `attachments:${id}:page:${selected + 1}`);
    }
    const text = `${view.summary}\n\n${view.entries.length} risultati · Pagina ${selected + 1}/${pages}\nTocca un file per dettagli e gestione.\nRicerca: /allegati testo`;
    if (edit) {
      await ctx.editMessageText(text, { reply_markup: keyboard });
    } else {
      await ctx.reply(text, { reply_markup: keyboard });
    }
  }
  async function showDetail(request: AttachmentAction) {
    const { ctx, id, view, index, entry, location } = request;
    const keyboard = new InlineKeyboard();

    view.pending = undefined;
    view.purgePending = undefined;
    keyboard
      .text(
        entry.archived ? "Ripristina…" : "Archivia…",
        `attachments:${id}:preview:${index}`
      )
      .row()
      .text(
        "← Elenco",
        `attachments:${id}:page:${Math.floor(index / PAGE_SIZE)}`
      );
    const purgeUnavailable = await attachmentPurgeAvailability(
      location,
      location.backupDir,
      entry
    );
    if (entry.archived && !purgeUnavailable) {
      keyboard.row().text("Libera spazio…", `attachments:${id}:purge:${index}`);
    }
    await ctx.editMessageText(
      `${display(entry.record.originalName)}\n${bytes(entry.record.size)} · ${display(entry.record.mimeType)}\nRicevuto: ${entry.record.receivedAt}\nOrigine: ${display(entry.record.scopeKey)}\nStato: ${entry.archived ? "archiviato" : "attivo"}\nSHA-256: ${entry.record.sha256}\n\nL’originale resta disponibile alle sessioni.${entry.archived && purgeUnavailable ? `\n\n${purgeUnavailable}` : ""}`,
      { reply_markup: keyboard }
    );
    return;
  }
  async function previewPurge(request: AttachmentAction) {
    const { ctx, id, view, index, entry, location } = request;
    const keyboard = new InlineKeyboard();
    if (!entry.archived) {
      return;
    }

    const unavailable = await attachmentPurgeAvailability(
      location,
      location.backupDir,
      entry
    );
    if (unavailable) {
      await ctx.reply(unavailable);
      return;
    }
    view.purgePending = index;
    keyboard
      .text(
        "Conferma rimozione dal disco",
        `attachments:${id}:purgeconfirm:${index}`
      )
      .row()
      .text("Annulla", `attachments:${id}:detail:${index}`);
    await ctx.editMessageText(
      `Rimuovere dal disco «${display(entry.record.originalName)}» (${bytes(entry.record.size)})?\n\nPrima verrà verificata una copia sul volume backup separato. Il percorso originale sarà eliminato: i riferimenti nelle conversazioni precedenti non funzioneranno più. Il ripristino dal backup richiederà intervento manuale. Nessun altro allegato verrà rimosso.`,
      { reply_markup: keyboard }
    );
    return;
  }
  async function confirmPurge(request: AttachmentAction) {
    const { ctx, id, view, index, entry, location } = request;
    if (view.purgePending !== index || !location.backupDir) {
      return;
    }

    view.purgePending = undefined;
    const result = await purgeAttachment(location, entry, location.backupDir);
    views.delete(id);
    await ctx.editMessageText(
      `Originale rimosso dal volume archivio: ${bytes(result.bytes)}. Copia verificata conservata sul volume backup. I vecchi riferimenti al file non sono più validi. Usa /allegati per aggiornare l’elenco.`
    );
    return;
  }
  async function previewArchive(request: AttachmentAction) {
    const { ctx, id, view, index, entry } = request;
    const keyboard = new InlineKeyboard();

    view.pending = index;
    keyboard
      .text(
        entry.archived ? "Conferma ripristino" : "Conferma archiviazione",
        `attachments:${id}:confirm:${index}`
      )
      .row()
      .text("Annulla", `attachments:${id}:detail:${index}`);
    await ctx.editMessageText(
      `${entry.archived ? "Ripristinare" : "Archiviare"} «${display(entry.record.originalName)}» (${bytes(entry.record.size)})?\n\nOperazione reversibile. Originale e percorso restano invariati. Spazio liberato: 0 byte. L’archiviazione organizza l’elenco; non elimina file dal disco.`,
      { reply_markup: keyboard }
    );
    return;
  }
  async function confirmArchive(request: AttachmentAction) {
    const { ctx, id, view, index, entry, location } = request;
    if (view.pending !== index) {
      return;
    }

    view.pending = undefined;
    view.purgePending = undefined;
    await setAttachmentArchived(location, entry, !entry.archived);
    views.delete(id);
    await ctx.editMessageText(
      entry.archived
        ? "Allegato ripristinato. Usa /allegati per aggiornare l’elenco."
        : "Allegato archiviato. Originale conservato; nessuno spazio liberato. Usa /allegati per aggiornare l’elenco."
    );
  }
  async function dispatchMutation(
    action: string | undefined,
    request: AttachmentAction
  ) {
    switch (action) {
      case "purge":
        await previewPurge(request);
        break;
      case "purgeconfirm":
        await confirmPurge(request);
        break;
      case "preview":
        await previewArchive(request);
        break;
      case "confirm":
        await confirmArchive(request);
        break;
      default:
        break;
    }
  }
  options.bot.command("allegati", async (ctx) => {
    const location = options.context(ctx);
    if (!location) {
      await ctx.reply(
        "Seleziona un progetto o apri il suo argomento per gestire gli allegati."
      );
      return;
    }
    try {
      const result = await scanAttachments({ ...location, search: ctx.match });
      clean();
      const id = randomBytes(8).toString("hex");
      const view: View = {
        binding: binding(ctx, location),
        expires: Date.now() + 10 * 60_000,
        entries: result.entries,
        summary: `Allegati · ${display(basename(location.projectPath))}\n${result.total} originali censiti · ${bytes(result.bytes)}\nArchiviati: ${bytes(result.archivedBytes)} (occupano ancora spazio).\n${result.skipped} elementi non validi ignorati.${result.truncated ? "\nScansione parziale: raggiunto il limite di 5.000 voci; conteggi parziali." : ""}`,
      };
      views.set(id, view);
      await showPage(ctx, id, view, 0, false);
    } catch {
      await ctx.reply(
        "Impossibile leggere l’archivio in sicurezza. Controlla percorso e permessi."
      );
    }
  });
  options.bot.callbackQuery(ATTACHMENT_CALLBACK, async (ctx) => {
    const [, id, action, value] = ctx.callbackQuery.data.split(":");
    const location = options.context(ctx);
    const view = id ? views.get(id) : undefined;
    if (
      !(id && location && view) ||
      view.expires < Date.now() ||
      view.binding !== binding(ctx, location)
    ) {
      await ctx.answerCallbackQuery({
        text: "Vista scaduta o progetto diverso. Usa /allegati.",
        show_alert: true,
      });
      return;
    }
    await ctx.answerCallbackQuery();
    const index = Number(value);
    if (!Number.isSafeInteger(index) || index < 0) {
      return;
    }
    try {
      if (action === "page") {
        view.pending = undefined;
        view.purgePending = undefined;
        await showPage(ctx, id, view, index, true);
        return;
      }
      const entry = view.entries[index];
      if (!entry) {
        return;
      }
      const request = { ctx, id, view, index, entry, location };
      if (action === "detail") {
        await showDetail(request);
        return;
      }
      if (location.busy) {
        await ctx.reply(
          "Attendi la fine dell’attività in questo progetto prima di gestire l’archivio."
        );
        return;
      }
      await dispatchMutation(action, request);
    } catch {
      views.delete(id);
      await ctx.reply(
        "Operazione non completata: il file è cambiato o non è verificabile. Aggiorna con /allegati."
      );
    }
  });
}
