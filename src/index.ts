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
 * The compaction threshold is set in the model config, not here:
 * it fires at limit.input - compaction.reserved (without limit.input, reserved is ignored).
 */
import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { archiveDocument, compactionPrompt, contextStub, splitSummary, type Index } from "./format"

type Options = {
  /** Archive directory, relative to the project directory. */
  dir?: string
  /** Write a `.gitignore` with `*` in the archive directory. */
  gitignore?: boolean
  /** Show a TUI toast when a compaction is archived. */
  toast?: boolean
  /** Target size of the <essential> block, as stated in the prompt. */
  essentialTokens?: number
  /** Target maximum size of the <detail> block, as stated in the prompt. */
  detailTokens?: number
}

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

  const opts = (options ?? {}) as Options
  const root = path.resolve(directory, opts.dir ?? path.join(".opencode", "compactions"))
  const essentialTokens = opts.essentialTokens ?? 1500
  const detailTokens = opts.detailTokens ?? 6000
  const pending = new Map<string, Promise<Index>>()

  const log = (level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) =>
    client.app.log({ body: { service: "compaction-vault", level, message, extra } }).catch(() => {})

  async function loadIndex(sessionID: string): Promise<Index> {
    try {
      return JSON.parse(await readFile(path.join(root, sessionID, "index.json"), "utf8"))
    } catch {
      return { sessionID, entries: [] }
    }
  }

  // Archives a summary exactly once per message: the event and the transform can race.
  function persist(sessionID: string, messageID: string, text: string): Promise<Index> {
    const key = `${sessionID}/${messageID}`
    const running = pending.get(key)
    if (running) return running
    const job = (async () => {
      const index = await loadIndex(sessionID)
      if (index.entries.some((e) => e.messageID === messageID)) return index

      const dir = path.join(root, sessionID)
      await mkdir(dir, { recursive: true })
      const ignore = path.join(root, ".gitignore")
      if (opts.gitignore !== false && !existsSync(ignore)) await writeFile(ignore, "*\n")

      const n = index.entries.length + 1
      const file = path.join(dir, `${String(n).padStart(3, "0")}.md`)
      const { essential, detail } = splitSummary(text)
      const created = new Date().toISOString()
      await writeFile(file, archiveDocument({ n, sessionID, created, essential, detail }))
      index.entries.push({ n, messageID, file, essential, created })
      await writeFile(path.join(dir, "index.json"), JSON.stringify(index, null, 2))

      await log("info", "compaction archived", { file, essentialChars: essential.length, detailChars: detail.length })
      if (opts.toast !== false)
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
      const index = await loadIndex(sessionID)
      const last = index.entries.at(-1)
      output.prompt = compactionPrompt({
        essentialTokens,
        detailTokens,
        prior: last && { essential: last.essential, files: index.entries.map((e) => e.file) },
      })
    },

    event: async ({ event }) => {
      if (event.type !== "session.compacted") return
      const sessionID = event.properties.sessionID
      try {
        const res = await client.session.messages({ path: { id: sessionID }, query: { directory } })
        const msg = (res.data ?? []).findLast((m: any) => isSummary(m.info))
        if (msg) await persist(sessionID, msg.info.id, summaryText(msg.parts))
      } catch (err) {
        await log("warn", "could not read the session after compaction", { error: String(err) })
      }
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      for (const msg of output.messages) {
        const info: any = msg.info
        if (!isSummary(info)) continue
        const text = summaryText(msg.parts)
        if (!text) continue

        const index = await persist(info.sessionID, info.id, text)
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
