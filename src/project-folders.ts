import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

/** Create only a new, direct child of the configured projects directory. */
export function createProjectFolder(root: string, name: string): string {
  if (!PROJECT_NAME.test(name)) {
    throw new Error(
      "Usa da 1 a 40 caratteri: lettere, numeri, trattini o underscore; inizia con una lettera o un numero."
    );
  }
  try {
    const path = join(realpathSync(root), name);
    mkdirSync(path, { mode: 0o700 });
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        "Il progetto esiste già. Sceglilo nella lista di /nuova per aprire un argomento."
      );
    }
    throw new Error(
      "Non riesco a creare la cartella del progetto. Verifica il percorso e i permessi su Ubuntu."
    );
  }
}
