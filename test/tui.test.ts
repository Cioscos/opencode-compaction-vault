import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadSettings, sanitize, saveSettings, settingsPath } from "../src/settings"
import plugin from "../src/tui"

let dir: string
let dialog: any
let toasts: any[]
let layers: any[]
let route: any

// The dialog components return their props, so the tests can drive them like a user would.
const component = (kind: string) => (props: any) => ({ kind, ...props })

function fakeApi(): any {
  return {
    state: { path: { directory: dir } },
    route: {
      get current() {
        return route
      },
    },
    keymap: { registerLayer: (input: any) => layers.push(input) },
    ui: {
      DialogSelect: component("select"),
      DialogPrompt: component("prompt"),
      DialogConfirm: component("confirm"),
      DialogAlert: component("alert"),
      toast: (input: any) => toasts.push(input),
      dialog: { replace: (render: () => any) => (dialog = render()), setSize: () => {}, clear: () => {} },
    },
  }
}

const command = (name: string) => layers[0].commands.find((c: any) => c.name === name)
const pick = (value: unknown) => dialog.options.find((o: any) => o.value === value).onSelect()
const row = (value: unknown) => dialog.options.find((o: any) => o.value === value)

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "vault-tui-"))
  process.env.OPENCODE_CONFIG_DIR = path.join(dir, "global")
  dialog = undefined
  toasts = []
  layers = []
  route = { name: "home" }
  await plugin.tui(fakeApi(), undefined, {} as any)
})
afterEach(async () => {
  delete process.env.OPENCODE_CONFIG_DIR
  await rm(dir, { recursive: true, force: true })
})

test("sanitize drops unknown keys and invalid values", () => {
  expect(sanitize({ enabled: "yes", toast: false, essentialTokens: 12, detailTokens: 4000.5, dir: " ", x: 1 })).toEqual({
    toast: false,
  })
  expect(sanitize({ essentialTokens: 800, dir: " notes " })).toEqual({ essentialTokens: 800, dir: "notes" })
})

test("precedence: options < global < project", async () => {
  await saveSettings("global", dir, { essentialTokens: 1000, detailTokens: 3000 })
  await saveSettings("project", dir, { detailTokens: 2000 })
  const { settings, origin } = await loadSettings(dir, { essentialTokens: 500, toast: false })
  expect(settings).toMatchObject({ essentialTokens: 1000, detailTokens: 2000, toast: false, gitignore: true })
  expect(origin).toMatchObject({ essentialTokens: "global", detailTokens: "project", toast: "options", dir: "default" })
})

test("registers the palette commands and an optional keybind", async () => {
  expect(layers).toHaveLength(1)
  expect(layers[0].commands.map((c: any) => c.slashName)).toEqual(["vault", "vault-archive"])
  // Gating the commands to a mode would hide them from the palette and from slash completion.
  expect(layers[0].mode).toBeUndefined()

  layers = []
  await plugin.tui(fakeApi(), { keybind: "ctrl+shift+v" }, {} as any)
  expect(layers[1]).toMatchObject({
    mode: "base",
    bindings: [{ key: "ctrl+shift+v", cmd: "compaction-vault.settings" }],
  })
})

test("toggling a setting saves it to the project file", async () => {
  await command("compaction-vault.settings").run()
  expect(row("toast")).toMatchObject({ description: "on", footer: "default" })

  await pick("toast")
  expect(row("toast")).toMatchObject({ description: "off", footer: "project" })
  expect(JSON.parse(await readFile(settingsPath("project", dir), "utf8"))).toEqual({ toast: false })
})

test("token prompt validates the value", async () => {
  await command("compaction-vault.settings").run()
  await pick("essentialTokens")
  expect(dialog).toMatchObject({ kind: "prompt", value: "1500" })
  await dialog.onConfirm("abc")
  expect(toasts.at(-1).variant).toBe("warning")
  expect(row("essentialTokens").description).toBe("1500")

  await pick("essentialTokens")
  await dialog.onConfirm(" 800 ")
  expect(row("essentialTokens")).toMatchObject({ description: "800", footer: "project" })
})

test("scope switch saves to the global file, reset deletes it", async () => {
  await command("compaction-vault.settings").run()
  await pick("scope")
  await pick("dir")
  await dialog.onConfirm("notes/vault")
  expect(row("dir")).toMatchObject({ description: "notes/vault", footer: "global" })
  expect(existsSync(settingsPath("project", dir))).toBe(false)

  await pick("reset")
  expect(dialog.kind).toBe("confirm")
  await dialog.onConfirm()
  expect(existsSync(settingsPath("global", dir))).toBe(false)
  expect(row("dir").footer).toBe("default")
})

test("archive browser lists the compactions of the current session", async () => {
  await command("compaction-vault.archive").run()
  expect(toasts.at(-1).message).toContain("Open a session")

  route = { name: "session", params: { sessionID: "ses_1" } }
  await command("compaction-vault.archive").run()
  expect(toasts.at(-1).message).toContain("No compaction")

  const folder = path.join(dir, ".opencode", "compactions", "ses_1")
  const file = path.join(folder, "001.md")
  await mkdir(folder, { recursive: true })
  await writeFile(
    path.join(folder, "index.json"),
    JSON.stringify({
      sessionID: "ses_1",
      entries: [{ n: 1, messageID: "m1", file, essential: "- ship it", created: "2026-01-02T03:04:05.000Z" }],
    }),
  )
  await command("compaction-vault.archive").run()
  expect(dialog.options).toHaveLength(1)
  expect(dialog.options[0]).toMatchObject({ title: "Compaction 1", footer: "2026-01-02 03:04" })

  pick(1)
  expect(dialog).toMatchObject({ kind: "alert" })
  expect(dialog.message).toContain("- ship it")
})
