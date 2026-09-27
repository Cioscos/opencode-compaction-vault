import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import plugin from "../src/index"
import { saveSettings } from "../src/settings"

const SUMMARY = "<essential>\n## Objective\n- ship it\n</essential>\n<detail>\n## Errors\n- ENOENT foo\n</detail>"

let dir: string
let messages: any[]

const client: any = {
  app: { log: async () => {} },
  tui: { showToast: async () => {} },
  session: { messages: async () => ({ data: messages }) },
}

function summaryMessage(id: string, text: string) {
  return {
    info: { id, sessionID: "ses_1", role: "assistant", summary: true, finish: "stop" },
    parts: [
      { id: `${id}-r`, type: "reasoning", text: "thinking" },
      { id: `${id}-t`, type: "text", text },
    ],
  }
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "vault-"))
  messages = []
  // Keeps the tests away from the real global settings file.
  process.env.OPENCODE_CONFIG_DIR = path.join(dir, "global")
})
afterEach(async () => {
  delete process.env.OPENCODE_CONFIG_DIR
  await rm(dir, { recursive: true, force: true })
})

test("settings files are picked up without a restart", async () => {
  const hooks: any = await plugin.server({ client, directory: dir } as any, { essentialTokens: 900 })
  const prompt = async () => {
    const output = { prompt: undefined as string | undefined, context: [] }
    await hooks["experimental.session.compacting"]({ sessionID: "ses_1" }, output)
    return output.prompt
  }
  expect(await prompt()).toContain("under about 900 tokens")

  await saveSettings("project", dir, { essentialTokens: 700, dir: "vault" })
  expect(await prompt()).toContain("under about 700 tokens")
  await hooks["experimental.chat.messages.transform"]({}, { messages: [summaryMessage("m1", SUMMARY)] })
  expect(existsSync(path.join(dir, "vault", "ses_1", "001.md"))).toBe(true)

  await saveSettings("project", dir, { enabled: false })
  expect(await prompt()).toBeUndefined()
  const msg = summaryMessage("m2", SUMMARY)
  await hooks["experimental.chat.messages.transform"]({}, { messages: [msg] })
  expect(msg.parts).toHaveLength(2)
  expect(existsSync(path.join(dir, "vault", "ses_1", "002.md"))).toBe(false)
})

test("archives the summary and replaces it in context", async () => {
  const hooks: any = await plugin.server({ client, directory: dir } as any)
  const msg = summaryMessage("m1", SUMMARY)
  const output = { messages: [{ info: { id: "u1", role: "user" }, parts: [] }, msg] }

  await hooks["experimental.chat.messages.transform"]({}, output)

  const file = path.join(dir, ".opencode", "compactions", "ses_1", "001.md")
  const doc = await readFile(file, "utf8")
  expect(doc).toContain("- ship it")
  expect(doc).toContain("- ENOENT foo")
  expect(await readFile(path.join(dir, ".opencode", "compactions", ".gitignore"), "utf8")).toBe("*\n")

  expect(msg.parts).toHaveLength(1)
  expect(msg.parts[0].text).toContain("- ship it")
  expect(msg.parts[0].text).not.toContain("ENOENT")
  expect(msg.parts[0].text).toContain(file)
})

test("event and transform archive the same summary only once", async () => {
  const hooks: any = await plugin.server({ client, directory: dir } as any)
  messages = [summaryMessage("m1", SUMMARY)]

  await Promise.all([
    hooks.event({ event: { type: "session.compacted", properties: { sessionID: "ses_1" } } }),
    hooks["experimental.chat.messages.transform"]({}, { messages: [summaryMessage("m1", SUMMARY)] }),
  ])

  const index = JSON.parse(await readFile(path.join(dir, ".opencode", "compactions", "ses_1", "index.json"), "utf8"))
  expect(index.entries).toHaveLength(1)
})

test("the next compaction prompt carries the prior essential", async () => {
  const hooks: any = await plugin.server({ client, directory: dir } as any)
  const first = { prompt: undefined as string | undefined, context: [] }
  await hooks["experimental.session.compacting"]({ sessionID: "ses_1" }, first)
  expect(first.prompt).not.toContain("<prior-essential>")

  await hooks["experimental.chat.messages.transform"]({}, { messages: [summaryMessage("m1", SUMMARY)] })
  const second = { prompt: undefined as string | undefined, context: [] }
  await hooks["experimental.session.compacting"]({ sessionID: "ses_1" }, second)
  expect(second.prompt).toContain("<prior-essential>\n## Objective\n- ship it\n</prior-essential>")
  expect(second.prompt).toContain("001.md")
})

test("options: custom dir and no gitignore", async () => {
  const hooks: any = await plugin.server({ client, directory: dir } as any, { dir: "notes/vault", gitignore: false })
  await hooks["experimental.chat.messages.transform"]({}, { messages: [summaryMessage("m1", SUMMARY)] })
  expect(existsSync(path.join(dir, "notes", "vault", "ses_1", "001.md"))).toBe(true)
  expect(existsSync(path.join(dir, "notes", "vault", ".gitignore"))).toBe(false)
})

test("COMPACTION_VAULT=off disables every hook", async () => {
  process.env.COMPACTION_VAULT = "off"
  try {
    expect(await plugin.server({ client, directory: dir } as any)).toEqual({})
  } finally {
    delete process.env.COMPACTION_VAULT
  }
})
