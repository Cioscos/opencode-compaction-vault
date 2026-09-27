# opencode-compaction-vault

[Italiano](README.it.md)

An [OpenCode](https://opencode.ai) plugin that moves compaction **to disk**. The model writes a detailed handoff document; the plugin archives it in your project and keeps only a short working memory in the context. The agent re-reads the archive with `read` only when it needs a specific detail.

It is built for **local models with small context windows** (for example a 27B model on llama.cpp with 64k tokens), where the default compaction summary costs context you cannot afford and loses the details you will need later.

## How it works

```
context full ──► compaction prompt (replaced by the plugin)
                   │
                   ▼
   model writes  <essential> short cumulative state ──► stays in context
                 <detail>    thorough archive       ──► .opencode/compactions/<session>/001.md
```

1. **Custom compaction prompt** (`experimental.session.compacting`). The model writes two blocks:
   - `<essential>`: objective, user directives and decisions, work state, next move, key files (about 1,500 tokens at most);
   - `<detail>`: an archive of the compacted segment only: decisions and reasons, failed attempts with exact errors, commands and outputs, changed code, discovered facts.

   From the second compaction on, the prompt includes the previous essential, which the model merges and updates, and the list of files already archived. Each file holds its own segment, so details are never re-summarized away.
2. **Archive on disk** (`session.compacted` event, with a fallback in the transform). The document is saved to `<project>/.opencode/compactions/<session>/NNN.md` with an `index.json`. A `.gitignore` containing `*` keeps the archive out of git.
3. **Lean context** (`experimental.chat.messages.transform`). Before every model request, the full summary is replaced by the essential block and the list of archived files.

If the model ignores the format (no `<essential>` block), the full text stays in context, so nothing is lost.

## Install

Add the plugin to your OpenCode config: `~/.config/opencode/opencode.json` for all projects, or `opencode.json` in a single project.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-compaction-vault@git+https://github.com/Cioscos/opencode-compaction-vault.git#v1.1.0"]
}
```

Restart OpenCode. The first compaction shows a toast such as `Compaction 1 archived in .opencode/compactions/...`.

Requires OpenCode **1.18.x** (the V1 `plugin` config key). The hooks it uses are marked `experimental` by OpenCode and may change in future releases.

## Set the threshold: compact before the context is full

The plugin does not decide *when* compaction happens; your model config does. From OpenCode's `session/overflow.ts`:

| model `limit` | compaction fires at |
|---|---|
| with `input` | `limit.input − compaction.reserved` |
| without `input` | `limit.context − limit.output` (**`reserved` is ignored**) |

So set `limit.input`, and use `reserved` to leave room for the model to write the document. Example for a llama.cpp server with 64k context:

```jsonc
{
  "provider": {
    "llamacpp": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:8080/v1" },
      "models": {
        "my-model": {
          "tool_call": true,
          "limit": { "context": 65536, "input": 65536, "output": 16384 }
        }
      }
    }
  },
  "compaction": { "auto": true, "prune": true, "reserved": 20000 }  // compacts at ~45k
}
```

Keep the threshold well above the post-compaction baseline: system prompt and tools (about 15k tokens with skill plugins such as superpowers), plus the recent turns OpenCode keeps (`compaction.preserve_recent_tokens`, up to 15k), plus the essential block. Below that, compaction fires on every step.

## Options

```json
{
  "plugin": [
    ["opencode-compaction-vault@git+https://github.com/Cioscos/opencode-compaction-vault.git#v1.1.0", {
      "dir": ".opencode/compactions",
      "gitignore": true,
      "toast": true,
      "essentialTokens": 1500,
      "detailTokens": 6000
    }]
  ]
}
```

| Option | Default | Meaning |
|---|---|---|
| `dir` | `.opencode/compactions` | Archive directory, relative to the project |
| `gitignore` | `true` | Write a `.gitignore` with `*` in the archive directory |
| `toast` | `true` | Show a TUI toast when a compaction is archived |
| `essentialTokens` | `1500` | Size limit for `<essential>`, stated in the prompt |
| `detailTokens` | `6000` | Size limit for `<detail>`, stated in the prompt |

Set the environment variable `COMPACTION_VAULT=off` to disable the plugin without editing the config.

## Change the settings from the TUI

The package also ships a TUI plugin. TUI plugins are configured in `tui.json` (next to `opencode.json`), so add the same spec there:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    ["opencode-compaction-vault@git+https://github.com/Cioscos/opencode-compaction-vault.git#v1.1.0", {
      "keybind": "ctrl+shift+v"
    }]
  ]
}
```

`keybind` is optional; without it the commands are reachable from the command palette and as slash commands.

| Command | Slash | What it does |
|---|---|---|
| Compaction Vault: settings | `/vault` | Edit every option above, plus an `enabled` switch |
| Compaction Vault: archive | `/vault-archive` | List the compactions archived for the current session and show their essential block |

Changes are written to a settings file and **apply immediately**: the server plugin re-reads it on every hook, no restart needed.

| File | Scope |
|---|---|
| `<project>/.opencode/compaction-vault.json` | this project (default target) |
| `~/.config/opencode/compaction-vault.json` | all projects |

Precedence: defaults < plugin options in `opencode.json` < global file < project file. In the dialog each row shows where its value comes from, *Save changes to* switches between the two files, and *Reset* deletes the selected one. The files are plain JSON with the same keys as the options, so you can also edit them by hand.

Changing `dir` in the middle of a session starts a new archive in the new directory: files already archived stay where they are.

## Results

Qwen3.8-27B IQ3_S on llama.cpp (RTX 4080 16 GB), threshold lowered to force compaction:

| | |
|---|---|
| Context before / after compaction | 24.6k → 16.4k tokens |
| Essential block kept in context | ~600 tokens |
| Archived document | 7–9 KB |
| Time per compaction | 1–2 min (5–8k tokens generated, reasoning on) |
| Recall | asked for an exact error message from before the compaction, the model read `002.md` on its own and quoted it |

## Development

```sh
bun install
bun test          # unit tests plus hook tests with a fake client
bun run typecheck
```

To try local changes, point OpenCode at the source file:

```json
{ "plugin": ["file:///absolute/path/to/opencode-compaction-vault/src/index.ts"] }
```

## License

MIT
