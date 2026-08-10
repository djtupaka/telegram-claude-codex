# Modello ed effort nello stato Telegram

## Obiettivo

Rendere verificabili da Telegram il modello Codex e il reasoning effort usati
dal bot, senza dedurre valori non disponibili e senza introdurre comandi che
modifichino la configurazione durante una sessione.

## Comportamento

- `/status` continua a mostrare provider, progetto, processo, sessioni, branch
  e code.
- Quando il provider attivo è Codex, aggiunge `Modello` ed `Effort`.
- I valori esplicitamente configurati per il bot sono mostrati così come sono.
- Se un valore è ereditato e il bot non può determinarlo con certezza, mostra
  `ereditato`; non presenta mai un valore presunto come effettivo.
- Per Claude non vengono inventati modello o effort non esposti dalla relativa
  configurazione.

## Politica operativa

- Default Codex: `gpt-5.6-sol` con effort `medium`.
- `high` resta una scelta esplicita per database live, permessi, sicurezza,
  migrazioni, refactoring complessi, bug difficili o verifiche delicate.
- La sicurezza continua a dipendere da backup, target corretto, test e
  verifiche; l'effort non sostituisce questi controlli.
- Non viene aggiunto per ora un comando Telegram per cambiare effort al volo.

## Implementazione e compatibilità

La visualizzazione legge la stessa configurazione già impiegata per creare il
thread Codex, evitando una seconda fonte di verità. La modifica resta isolata
dal lavoro non ancora consolidato presente nel repository e non cambia le
sessioni esistenti, il provider selezionato o il comportamento degli altri
comandi.

## Verifica

- Test mirato inizialmente rosso per lo stato Codex con valori espliciti.
- Test per valori ereditati, senza valori inventati.
- Test di regressione dello stato Claude.
- Typecheck, lint e suite del bot prima del riavvio.
- Verifica manuale finale con `/status` dopo un riavvio controllato.
