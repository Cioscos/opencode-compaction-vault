/**
 * TUI target of opencode-compaction-vault.
 *
 * Adds two commands to the command palette:
 *   /vault          edit the plugin settings (saved to compaction-vault.json)
 *   /vault-archive  browse the compactions archived for the current session
 *
 * The server plugin re-reads the settings on every hook, so changes apply without a restart.
 * The host dialog components are called as plain functions, so this file needs no JSX.
 */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Index } from "./format"
import {
  TOKEN_RANGE,
  loadSettings,
  resetSettings,
  saveSettings,
  settingsPath,
  type Scope,
  type Settings,
} from "./settings"

type TuiOptions = {
  /** Key that opens the settings dialog, for example "ctrl+shift+v". Unbound by default. */
  keybind?: string
}

type Row = { title: string; category: string; value: string; description?: string; footer?: string; run: () => unknown }

const BOOLEANS = {
  enabled: "Enabled",
  toast: "Toast on archive",
  gitignore: "Write .gitignore in the archive",
} as const

const TOKENS = {
  essentialTokens: "Essential size (tokens)",
  detailTokens: "Detail size (tokens)",
} as const

const tui: TuiPlugin = async (api, options) => {
  const opts = (options ?? {}) as TuiOptions
  let scope: Scope = "project"

  const directory = () => api.state.path.directory || process.cwd()
  const fail = (err: unknown) => api.ui.toast({ variant: "error", title: "Compaction Vault", message: String(err) })
  const guard = (fn: () => unknown) => () => Promise.resolve().then(fn).catch(fail)

  async function save(patch: Partial<Settings>, current: string) {
    await saveSettings(scope, directory(), patch)
    await openSettings(current)
  }

  function promptTokens(key: keyof typeof TOKENS, value: number) {
    api.ui.dialog.replace(() =>
      api.ui.DialogPrompt({
        title: TOKENS[key],
        placeholder: `${TOKEN_RANGE.min} - ${TOKEN_RANGE.max}`,
        value: String(value),
        onCancel: guard(() => openSettings(key)),
        onConfirm: (text) =>
          guard(() => {
            const n = Number(text.trim())
            if (!Number.isInteger(n) || n < TOKEN_RANGE.min || n > TOKEN_RANGE.max) {
              api.ui.toast({
                variant: "warning",
                message: `Enter a whole number between ${TOKEN_RANGE.min} and ${TOKEN_RANGE.max}`,
              })
              return openSettings(key)
            }
            return save({ [key]: n }, key)
          })(),
      }),
    )
  }

  function promptDir(value: string) {
    api.ui.dialog.replace(() =>
      api.ui.DialogPrompt({
        title: "Archive directory",
        placeholder: "relative to the project directory",
        value,
        onCancel: guard(() => openSettings("dir")),
        onConfirm: (text) => guard(() => (text.trim() ? save({ dir: text.trim() }, "dir") : openSettings("dir")))(),
      }),
    )
  }

  async function openSettings(current?: string) {
    const { settings, origin } = await loadSettings(directory(), options)
    const file = settingsPath(scope, directory())

    const rows: Row[] = [
      ...(Object.keys(BOOLEANS) as (keyof typeof BOOLEANS)[]).map((key) => ({
        title: BOOLEANS[key],
        category: "Behaviour",
        value: key,
        description: settings[key] ? "on" : "off",
        footer: origin[key],
        run: () => save({ [key]: !settings[key] }, key),
      })),
      ...(Object.keys(TOKENS) as (keyof typeof TOKENS)[]).map((key) => ({
        title: TOKENS[key],
        category: "Prompt",
        value: key,
        description: String(settings[key]),
        footer: origin[key],
        run: () => promptTokens(key, settings[key]),
      })),
      {
        title: "Archive directory",
        category: "Storage",
        value: "dir",
        description: settings.dir,
        footer: origin.dir,
        run: () => promptDir(settings.dir),
      },
      {
        title: "Save changes to",
        category: "Settings file",
        value: "scope",
        description: scope,
        // The full path does not fit in the dialog.
        footer: scope === "project" ? path.relative(directory(), file) : file.replace(os.homedir(), "~"),
        run: () => {
          scope = scope === "project" ? "global" : "project"
          return openSettings("scope")
        },
      },
      {
        title: `Reset ${scope} settings`,
        category: "Settings file",
        value: "reset",
        description: "delete the file above",
        run: () =>
          api.ui.dialog.replace(() =>
            api.ui.DialogConfirm({
              title: `Reset ${scope} settings`,
              message: `Delete ${file}?`,
              onCancel: guard(() => openSettings("reset")),
              onConfirm: guard(async () => {
                await resetSettings(scope, directory())
                await openSettings("reset")
              }),
            }),
          ),
      },
    ]

    api.ui.dialog.replace(() =>
      api.ui.DialogSelect<string>({
        title: "Compaction Vault",
        current,
        options: rows.map(({ run, ...row }) => ({ ...row, onSelect: guard(run) })),
      }),
    )
  }

  async function openArchive() {
    const route = api.route.current
    const sessionID = route.name === "session" ? (route.params as { sessionID?: string } | undefined)?.sessionID : undefined
    if (!sessionID) return api.ui.toast({ variant: "info", message: "Open a session to browse its archive" })

    const { settings } = await loadSettings(directory(), options)
    const file = path.join(path.resolve(directory(), settings.dir), sessionID, "index.json")
    const index: Index = await readFile(file, "utf8").then(JSON.parse, () => ({ sessionID, entries: [] }))
    if (!index.entries.length)
      return api.ui.toast({ variant: "info", message: "No compaction archived for this session yet" })

    const list = (current?: number) =>
      api.ui.dialog.replace(() =>
        api.ui.DialogSelect<number>({
          title: "Archived compactions",
          current,
          options: index.entries.map((e) => ({
            title: `Compaction ${e.n}`,
            value: e.n,
            description: path.relative(directory(), e.file),
            footer: e.created.slice(0, 16).replace("T", " "),
            onSelect: () =>
              api.ui.dialog.replace(() =>
                api.ui.DialogAlert({
                  title: `Compaction ${e.n} · essential`,
                  message: `${e.essential}\n\n${e.file}`,
                  onConfirm: () => list(e.n),
                }),
              ),
          })),
        }),
      )
    api.ui.dialog.setSize("large")
    list(index.entries.at(-1)!.n)
  }

  // No `mode` here: the palette runs in "modal" and slash completion in "autocomplete",
  // so a layer gated to "base" would hide the commands from both.
  api.keymap.registerLayer({
    commands: [
      {
        name: "compaction-vault.settings",
        title: "Compaction Vault: settings",
        category: "Plugin",
        namespace: "palette",
        slashName: "vault",
        run: guard(() => openSettings()),
      },
      {
        name: "compaction-vault.archive",
        title: "Compaction Vault: archive",
        category: "Plugin",
        namespace: "palette",
        slashName: "vault-archive",
        run: guard(openArchive),
      },
    ],
  })
  if (opts.keybind)
    api.keymap.registerLayer({
      mode: "base",
      bindings: [{ key: opts.keybind, cmd: "compaction-vault.settings", desc: "Compaction Vault settings" }],
    })
}

export default { id: "compaction-vault", tui } satisfies TuiPluginModule
