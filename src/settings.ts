/**
 * Settings shared by the server plugin and the TUI plugin.
 *
 * The two targets run as separate modules, so they talk through files:
 *   <config dir>/compaction-vault.json          global overrides
 *   <project>/.opencode/compaction-vault.json   project overrides
 *
 * Precedence: defaults < plugin options (opencode.json) < global file < project file.
 * The server re-reads the files on every hook, so a change made in the TUI applies at once.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export type Settings = {
  /** Master switch: when false the plugin leaves compaction untouched. */
  enabled: boolean
  /** Archive directory, relative to the project directory. */
  dir: string
  /** Write a `.gitignore` with `*` in the archive directory. */
  gitignore: boolean
  /** Show a TUI toast when a compaction is archived. */
  toast: boolean
  /** Target size of the <essential> block, as stated in the prompt. */
  essentialTokens: number
  /** Target maximum size of the <detail> block, as stated in the prompt. */
  detailTokens: number
}

export type Scope = "project" | "global"
export type Origin = Scope | "options" | "default"

export const DEFAULTS: Settings = {
  enabled: true,
  dir: path.join(".opencode", "compactions"),
  gitignore: true,
  toast: true,
  essentialTokens: 1500,
  detailTokens: 6000,
}

export const SETTINGS_FILE = "compaction-vault.json"
export const TOKEN_RANGE = { min: 100, max: 200_000 }

export function globalConfigDir() {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode")
}

export function settingsPath(scope: Scope, directory: string) {
  return scope === "global"
    ? path.join(globalConfigDir(), SETTINGS_FILE)
    : path.join(directory, ".opencode", SETTINGS_FILE)
}

const validTokens = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= TOKEN_RANGE.min && v <= TOKEN_RANGE.max

/** Keeps only the known keys that hold a valid value; everything else is dropped. */
export function sanitize(input: unknown): Partial<Settings> {
  if (!input || typeof input !== "object") return {}
  const raw = input as Record<string, unknown>
  const out: Partial<Settings> = {}
  for (const key of ["enabled", "gitignore", "toast"] as const) if (typeof raw[key] === "boolean") out[key] = raw[key]
  for (const key of ["essentialTokens", "detailTokens"] as const) if (validTokens(raw[key])) out[key] = raw[key]
  if (typeof raw.dir === "string" && raw.dir.trim()) out.dir = raw.dir.trim()
  return out
}

export async function readOverrides(file: string): Promise<Partial<Settings>> {
  try {
    return sanitize(JSON.parse(await readFile(file, "utf8")))
  } catch {
    return {}
  }
}

/** Resolved settings plus, for every key, the layer its value comes from. */
export async function loadSettings(directory: string, options?: unknown) {
  const layers: [Origin, Partial<Settings>][] = [
    ["options", sanitize(options)],
    ["global", await readOverrides(settingsPath("global", directory))],
    ["project", await readOverrides(settingsPath("project", directory))],
  ]
  const settings = { ...DEFAULTS }
  const origin = Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, "default"])) as Record<keyof Settings, Origin>
  for (const [name, layer] of layers)
    for (const key of Object.keys(layer) as (keyof Settings)[]) {
      Object.assign(settings, { [key]: layer[key] })
      origin[key] = name
    }
  return { settings, origin }
}

/** Merges `patch` into the overrides file of the given scope. Invalid values are ignored. */
export async function saveSettings(scope: Scope, directory: string, patch: Partial<Settings>) {
  const file = settingsPath(scope, directory)
  const next = { ...(await readOverrides(file)), ...sanitize(patch) }
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(next, null, 2) + "\n")
  return next
}

/** Removes the overrides file of the given scope. */
export async function resetSettings(scope: Scope, directory: string) {
  await rm(settingsPath(scope, directory), { force: true })
}
