/**
 * Pure helpers: compaction prompt, parsing of the model output and the
 * text that replaces the full summary in the model context.
 */

export type Entry = {
  n: number
  messageID: string
  file: string
  essential: string
  created: string
}

export type Index = {
  sessionID: string
  entries: Entry[]
}

export function compactionPrompt(input: {
  essentialTokens: number
  detailTokens: number
  prior?: { essential: string; files: string[] }
}) {
  const base = `You are compacting a long coding session. After this, the agent's context is reset: it keeps ONLY the <essential> block you write, while the <detail> block is saved to a file on disk that the agent can re-read on demand.

Respond with EXACTLY these two blocks and nothing else:

<essential>
## Objective
- what the user is trying to accomplish (1-2 bullets)
## User directives and decisions
- constraints, preferences and decisions still in force, with the reason in a few words
## Work state
- Done: ...
- Active: ... (partial changes, where you stopped)
- Blocked: ... (or "none")
## Next move
1. the immediate concrete action
2. the following one, if known
## Key files
- path: why it matters
</essential>

<detail>
A thorough archive of the conversation segment below, for later lookup. Include:
- decisions and the reasoning behind them, alternatives rejected and why
- approaches tried that failed, with the exact error or symptom
- exact commands run and the relevant part of their output
- code changed: files, functions/symbols, line references, short snippets when useful
- facts discovered about the codebase, APIs, configuration or environment
- open questions and loose ends
Use as much space as needed (up to about ${input.detailTokens} tokens), organised with Markdown headings.
</detail>

Rules:
- <essential> must stay under about ${input.essentialTokens} tokens: terse bullets, no prose.
- Preserve exact file paths, identifiers, commands, error strings and URLs.
- Write in the same language the user writes in.
- Do not mention the compaction process.`

  if (!input.prior) return base
  return `${base}

<prior-essential>
${input.prior.essential}
</prior-essential>

The <prior-essential> summarizes everything that happened before the conversation below. Merge it into the new <essential>: carry forward objectives, directives, decisions and open work even if the conversation does not mention them; where they conflict the conversation wins; drop only what is finished and no longer needed.
The new <detail> must cover ONLY the conversation below: earlier segments are already archived in:
${input.prior.files.map((f) => `- ${f}`).join("\n")}`
}

/** Splits the model output. Without an <essential> block the whole text is kept in context, so nothing is lost. */
export function splitSummary(text: string) {
  const essential = text.match(/<essential>([\s\S]*?)(?:<\/essential>|<detail>|$)/i)?.[1]?.trim()
  const detail = text.match(/<detail>([\s\S]*?)(?:<\/detail>|$)/i)?.[1]?.trim()
  if (!essential) return { essential: text.trim(), detail: "" }
  return { essential, detail: detail ?? "" }
}

export function archiveDocument(input: { n: number; sessionID: string; created: string; essential: string; detail: string }) {
  return (
    `# Compaction ${input.n} · session ${input.sessionID}\n\n_${input.created}_\n\n` +
    `## Essential (cumulative state)\n\n${input.essential}\n\n` +
    `## Detail of this segment\n\n${input.detail || "(the model did not produce a <detail> block)"}\n`
  )
}

/** Text that replaces the full summary in the model context. */
export function contextStub(entry: Entry, archive: Entry[]) {
  return (
    `[Session memory: compacted ${entry.n} time${entry.n === 1 ? "" : "s"}]\n\n` +
    `${entry.essential}\n\n` +
    `Archived details (read them with the read tool only when you need specifics that are not above):\n` +
    archive.map((e) => `- ${e.file} (segment ${e.n})`).join("\n")
  )
}
