# Preferenze per progetto

`/preferenze` mostra assistente, modello e ragionamento salvati per il progetto della conversazione e le impostazioni attuali. **Salva impostazioni attuali come preferite** registra le impostazioni mostrate; **Rimuovi preferenze** ripristina i valori predefiniti per i nuovi argomenti. Entrambe le operazioni sono reversibili e non modificano conversazioni o esecuzioni già esistenti.

I nuovi argomenti mantengono sempre l'assistente scelto esplicitamente. Modello e ragionamento preferiti vengono applicati soltanto quando l'assistente scelto corrisponde a quello salvato. Questo comportamento vale anche per lo script di creazione degli argomenti, che usa lo stesso servizio.

L'archivio locale è `.data/project-preferences.json`, versione 1, con una mappa `projects` indicizzata dal percorso reale del progetto: collegamenti simbolici allo stesso progetto condividono le preferenze. Ogni voce contiene `provider`, `model` ed `effort`, validati rispetto al registro degli assistenti. I valori `default` seguono il valore predefinito dell'assistente.

Il file viene scritto con permessi `0600` attraverso un file temporaneo e una rinomina atomica. Un lock esclusivo protegge la lettura e l'aggiornamento anche tra processi; richieste concorrenti possono essere riprovate. Un lock rimasto dopo un arresto anomalo richiede una verifica dell'assenza di processi che stiano scrivendo prima della rimozione manuale.

Un archivio malformato o con valori non più riconosciuti blocca letture e modifiche: il contenuto viene preservato per consentirne il recupero. La creazione di un nuovo argomento si interrompe prima della chiamata Telegram in caso di errore dell'archivio. Non viene sostituito silenziosamente con un archivio vuoto.

I pulsanti hanno una validità di dieci minuti e sono vincolati a utente, conversazione e progetto. Salvataggio e rimozione consumano il pulsante; il menu aggiornato ne genera uno nuovo. Il salvataggio usa le impostazioni mostrate al momento dell'apertura del menu.

Verifica locale: `bun test src/project-preferences.test.ts src/bot-preferences.test.ts src/topics.test.ts`.
