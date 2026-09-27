/**
 * opencode-compaction-vault: on-disk compaction for models with a small context window.
 *
 * On compaction the model writes two blocks:
 *   <essential>  short cumulative working memory: the only thing kept in context
 *   <detail>     thorough archive of the compacted segment: written to a file
 *
 * The plugin saves the document to <project>/<dir>/<session>/NNN.md and, before every
 * request to the model, replaces the full summary with the essential part plus the list
 * of archived files, which the agent re-reads with `read` when it needs the details.
 *
 * Settings come from the plugin options and from the files described in ./settings,
 * which the TUI target (./tui) edits at runtime.
 *
 * The compaction threshold is set in the model config, not here:
 * it fires at limit.input - compaction.reserved (without limit.input, reserved is ignored).
 */
import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { archiveDocument, compactionPrompt, contextStub, splitSummary, type Index } from "./format"
import { loadSettings, type Settings } from "./settings"

function summaryText(parts: any[]) {
  return parts
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text.trim())
    .join("\n\n")
    .trim()
}

const isSummary = (info: any) => info?.role === "assistant" && info.summary && info.finish && !info.error

const server: Plugin = async ({ client, directory }, options) => {
  if (process.env.COMPACTION_VAULT === "off") return {}

  const pending = new Map<string, Promise<Index>>()

  // Read on every hook: the TUI plugin edits the settings files while the server runs.
  const current = async () => (await loadSettings(directory, options)).settings
  const rootOf = (settings: Settings) => path.resolve(directory, settings.dir)

  const log = (level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) =>
    client.app.log({ body: { service: "compaction-vault", level, message, extra } }).catch(() => {})

  async function loadIndex(root: string, sessionID: string): Promise<Index> {
    try {
      return JSON.parse(await readFile(path.join(root, sessionID, "index.json"), "utf8"))
    } catch {
      return { sessionID, entries: [] }
    }
  }

  // Archives a summary exactly once per message: the event and the transform can race.
  function persist(settings: Settings, sessionID: string, messageID: string, text: string): Promise<Index> {
    const key = `${sessionID}/${messageID}`
    const running = pending.get(key)
    if (running) return running
    const job = (async () => {
      const root = rootOf(settings)
      const index = await loadIndex(root, sessionID)
      if (index.entries.some((e) => e.messageID === messageID)) return index

      const dir = path.join(root, sessionID)
      await mkdir(dir, { recursive: true })
      const ignore = path.join(root, ".gitignore")
      if (settings.gitignore && !existsSync(ignore)) await writeFile(ignore, "*\n")

      const n = index.entries.length + 1
      const file = path.join(dir, `${String(n).padStart(3, "0")}.md`)
      const { essential, detail } = splitSummary(text)
      const created = new Date().toISOString()
      await writeFile(file, archiveDocument({ n, sessionID, created, essential, detail }))
      index.entries.push({ n, messageID, file, essential, created })
      await writeFile(path.join(dir, "index.json"), JSON.stringify(index, null, 2))

      await log("info", "compaction archived", { file, essentialChars: essential.length, detailChars: detail.length })
      if (settings.toast)
        client.tui
          .showToast({ body: { message: `Compaction ${n} archived in ${path.relative(directory, file)}`, variant: "info" } })
          .catch(() => {})
      return index
    })()
    pending.set(key, job)
    job.finally(() => pending.delete(key)).catch((err) => log("error", "archiving failed", { error: String(err) }))
    return job
  }

  return {
    "experimental.session.compacting": async ({ sessionID }, output) => {
      const settings = await current()
      if (!settings.enabled) return
      const index = await loadIndex(rootOf(settings), sessionID)
      const last = index.entries.at(-1)
      output.prompt = compactionPrompt({
        essentialTokens: settings.essentialTokens,
        detailTokens: settings.detailTokens,
        prior: last && { essential: last.essential, files: index.entries.map((e) => e.file) },
      })
    },

    event: async ({ event }) => {
      if (event.type !== "session.compacted") return
      const sessionID = event.properties.sessionID
      try {
        const settings = await current()
        if (!settings.enabled) return
        const res = await client.session.messages({ path: { id: sessionID }, query: { directory } })
        const msg = (res.data ?? []).findLast((m: any) => isSummary(m.info))
        if (msg) await persist(settings, sessionID, msg.info.id, summaryText(msg.parts))
      } catch (err) {
        await log("warn", "could not read the session after compaction", { error: String(err) })
      }
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      if (!output.messages.some((m) => isSummary(m.info))) return
      const settings = await current()
      if (!settings.enabled) return

      for (const msg of output.messages) {
        const info: any = msg.info
        if (!isSummary(info)) continue
        const text = summaryText(msg.parts)
        if (!text) continue

        const index = await persist(settings, info.sessionID, info.id, text)
        const entry = index.entries.find((e) => e.messageID === info.id)
        if (!entry) continue

        const first = msg.parts.find((p: any) => p.type === "text")!
        msg.parts = [
          ...msg.parts.filter((p: any) => p.type !== "text" && p.type !== "reasoning"),
          { ...first, text: contextStub(entry, index.entries.filter((e) => e.n <= entry.n)) },
        ] as typeof msg.parts
      }
    },
  }
}

export default { id: "compaction-vault", server } satisfies PluginModule
