import { invoke } from "@tauri-apps/api/core"
import type { GlobalShortcut } from "@/lib/settings"

export type GlobalShortcutStatus = {
  shortcut: GlobalShortcut
  active: boolean
  error: string | null
}

let recordingTail: Promise<void> = Promise.resolve()
export function setGlobalShortcutRecording(recording: boolean): Promise<void> {
  const request = recordingTail.then(() => invoke<void>("set_global_shortcut_recording", { recording }))
  // Keep later recorder changes ordered after a rejected request; callers still receive its rejection.
  recordingTail = request.then(() => undefined, () => undefined)
  return request
}

export const getGlobalShortcutStatus = () => invoke<GlobalShortcutStatus>("get_global_shortcut_status")
export const applyGlobalShortcut = (shortcut: GlobalShortcut) =>
  invoke<GlobalShortcutStatus>("update_global_shortcut", { shortcut })

const MODIFIERS = [
  { prefix: "Meta", value: "Command", label: "⌘" },
  { prefix: "Control", value: "Control", label: "⌃" },
  { prefix: "Alt", value: "Alt", label: "⌥" },
  { prefix: "Shift", value: "Shift", label: "⇧" },
]

const KEY_LABELS: Record<string, string> = {
  CommandOrControl: "⌘", Command: "⌘", Control: "⌃", Alt: "⌥", Option: "⌥", Shift: "⇧",
  Return: "↵", Enter: "↵", Space: "Space", Backspace: "⌫", Delete: "⌦",
  ArrowUp: "↑", Up: "↑", ArrowDown: "↓", Down: "↓", ArrowLeft: "←", Left: "←", ArrowRight: "→", Right: "→",
  Tab: "⇥", PageUp: "PgUp", PageDown: "PgDn", BracketLeft: "[", BracketRight: "]",
  Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backquote: "`", Minus: "-", Equal: "=",
}

export function shortcutKeycaps(shortcut: string): string[] {
  return shortcut.split("+").map((key) => KEY_LABELS[key] ?? key.replace(/^Numpad/, "Num"))
}

export function recordedShortcut(codes: Set<string>): { keys: string[]; shortcut: GlobalShortcut; invalid: boolean } {
  const modifiers = MODIFIERS.filter((modifier) => [...codes].some((code) => code.startsWith(modifier.prefix)))
  const main = [...codes].filter((code) => !MODIFIERS.some((modifier) => code.startsWith(modifier.prefix)))
  const keys = [...modifiers.map((modifier) => modifier.label), ...main.map((code) => KEY_LABELS[code] ?? code.replace(/^(Key|Digit)/, "").replace(/^Numpad/, "Num"))]
  const mainKey = main[0]?.replace(/^(Key|Digit)/, "").replace(/^Arrow/, "").replace(/^Enter$/, "Return")
  return {
    keys,
    invalid: main.length > 1,
    shortcut: modifiers.length > 0 && main.length === 1 ? [...modifiers.map((modifier) => modifier.value), mainKey].join("+") : null,
  }
}
