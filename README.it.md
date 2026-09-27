# opencode-compaction-vault

[English](README.md)

Plugin per [OpenCode](https://opencode.ai) che sposta la compattazione **su disco**. Il modello scrive un documento di passaggio dettagliato; il plugin lo archivia nel progetto e nel contesto lascia solo una breve memoria di lavoro. L'agente rilegge l'archivio con `read` solo quando gli serve un dettaglio.

È pensato per i **modelli locali con poco contesto**, per esempio un 27B su llama.cpp con 64k token. In questi casi il riassunto di default costa contesto che non hai e perde i dettagli che ti serviranno dopo.

## Come funziona

1. **Prompt di compattazione personalizzato** (`experimental.session.compacting`). Il modello scrive due blocchi:
   - `<essential>`: obiettivo, direttive dell'utente, stato del lavoro, prossimo passo, file chiave (al massimo circa 1.500 token);
   - `<detail>`: archivio del solo segmento compattato: decisioni con le ragioni, tentativi falliti con gli errori esatti, comandi e output, codice modificato, fatti scoperti.

   Dalla seconda compattazione in poi, il prompt contiene l'essenziale precedente, che il modello aggiorna, e l'elenco dei file già archiviati.
2. **Archivio su disco.** Il documento viene salvato in `<progetto>/.opencode/compactions/<sessione>/NNN.md` insieme a un `index.json`; un `.gitignore` lo esclude da git.
3. **Contesto snello** (`experimental.chat.messages.transform`). Prima di ogni richiesta al modello, il riassunto completo viene sostituito con l'essenziale e l'elenco dei file archiviati.

Se il modello non rispetta il formato, nel contesto resta il testo intero: non si perde niente.

## Installazione

In `~/.config/opencode/opencode.json` (tutti i progetti) oppure in `opencode.json` del singolo progetto:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-compaction-vault@git+https://github.com/Cioscos/opencode-compaction-vault.git#v1.0.0"]
}
```

Poi riavvia OpenCode. Richiede OpenCode **1.18.x**; gli hook usati sono `experimental` e potrebbero cambiare.

## Soglia di compattazione

Il momento della compattazione lo decide la configurazione del modello, non il plugin:

- con `limit.input`: soglia = `limit.input − compaction.reserved`;
- senza `limit.input`: soglia = `limit.context − limit.output`, e `reserved` **viene ignorato**.

Con `"limit": { "context": 65536, "input": 65536, "output": 16384 }` e `"compaction": { "reserved": 20000 }` si compatta a circa 45k. Tieni la soglia ben sopra la base che resta dopo una compattazione: system prompt e tool (circa 15k con superpowers), più la parte recente conservata (fino a 15k), più l'essenziale. Altrimenti la compattazione scatta a ogni passo.

## Opzioni

`dir` (default `.opencode/compactions`), `gitignore` (`true`), `toast` (`true`), `essentialTokens` (`1500`), `detailTokens` (`6000`). Si passano con la forma `["<spec>", { ... }]`: vedi il [README inglese](README.md#options). `COMPACTION_VAULT=off` disattiva il plugin.

## Licenza

MIT
