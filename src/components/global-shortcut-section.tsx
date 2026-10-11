import { useEffect, useRef, useState } from "react"
import { isTauri } from "@tauri-apps/api/core"
import { Keyboard, LoaderCircle, Pencil, TriangleAlert, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { getGlobalShortcutStatus, recordedShortcut, setGlobalShortcutRecording, shortcutKeycaps, type GlobalShortcutStatus } from "@/lib/global-shortcut"
import type { GlobalShortcut } from "@/lib/settings"

interface GlobalShortcutSectionProps {
  globalShortcut: GlobalShortcut
  onGlobalShortcutChange: (value: GlobalShortcut) => Promise<void> | void
}

function Keycaps({ keys }: { keys: string[] }) {
  return <span className="flex items-center gap-1">{keys.map((key, index) => <kbd key={`${key}-${index}`} className="min-w-7 rounded border border-border bg-background px-1.5 py-1 text-center font-sans text-sm shadow-[0_1px_0_var(--border)]">{key}</kbd>)}</span>
}

export function GlobalShortcutSection({ globalShortcut, onGlobalShortcutChange }: GlobalShortcutSectionProps) {
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const [keys, setKeys] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<GlobalShortcutStatus | null>(null)
  const pressed = useRef(new Set<string>())
  const candidate = useRef<GlobalShortcut>(null)
  const invalidChord = useRef(false)
  const commandSeen = useRef(false)
  const recordingRef = useRef<HTMLDivElement>(null)
  const mounted = useRef(true)
  const statusVersion = useRef(0)
  const recordingActive = useRef(false)

  useEffect(() => {
    mounted.current = true
    let cancelled = false
    const version = statusVersion.current
    if (isTauri()) {
      getGlobalShortcutStatus().then((value) => {
        if (!cancelled && version === statusVersion.current) setStatus(value)
      }).catch((cause) => {
        console.error("Failed to read global shortcut status:", cause)
        if (!cancelled && version === statusVersion.current) setError("无法读取快捷键状态。")
      })
    }
    return () => {
      cancelled = true
      mounted.current = false
      commandSeen.current = false
      if (recordingActive.current) {
        recordingActive.current = false
        void setGlobalShortcutRecording(false).catch((cause) => console.error("Failed to restore shortcut after recorder closed:", cause))
      }
    }
  }, [])

  useEffect(() => { if (recording) recordingRef.current?.focus() }, [recording])

  const stopRecording = () => {
    if (recordingActive.current) {
      recordingActive.current = false
      void setGlobalShortcutRecording(false).catch((cause) => {
        console.error("Failed to restore global shortcut after recording:", cause)
        if (mounted.current) setError("无法恢复快捷键，请重新设置。")
      })
    }
    pressed.current.clear()
    candidate.current = null
    invalidChord.current = false
    commandSeen.current = false
    setKeys([])
    setRecording(false)
    setError(null)
  }

  const startRecording = async () => {
    setError(null)
    try {
      if (isTauri()) await setGlobalShortcutRecording(true)
      if (!mounted.current) {
        if (isTauri()) await setGlobalShortcutRecording(false)
        return
      }
      recordingActive.current = isTauri()
      pressed.current.clear()
      candidate.current = null
      invalidChord.current = false
      commandSeen.current = false
      setKeys([])
      setRecording(true)
    } catch (cause) {
      console.error("Failed to begin shortcut recording:", cause)
      if (mounted.current) setError("无法开始录制快捷键，请重试。")
    }
  }

  const apply = async (value: GlobalShortcut) => {
    statusVersion.current += 1
    setBusy(true)
    setError(null)
    stopRecording()
    try {
      await onGlobalShortcutChange(value)
      if (mounted.current) setStatus({ shortcut: value, active: value !== null, error: null })
    } catch (cause) {
      console.error("Failed to apply recorded shortcut:", cause)
      if (mounted.current) setError(typeof cause === "string" ? cause : "无法应用快捷键，请重试。")
      if (isTauri()) {
        try {
          const actual = await getGlobalShortcutStatus()
          if (mounted.current) setStatus(actual)
        } catch (statusError) {
          console.error("Failed to verify global shortcut after update failure:", statusError)
          if (mounted.current) setStatus(null)
        }
      }
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const syncModifiers = (event: React.KeyboardEvent) => {
    // OS combinations can report modifiers only as flags on the main key event.
    for (const [prefix, active] of [["Meta", event.metaKey], ["Control", event.ctrlKey], ["Alt", event.altKey], ["Shift", event.shiftKey]] as const) {
      const codes = [...pressed.current].filter((code) => code.startsWith(prefix))
      if (active && codes.length === 0) pressed.current.add(`${prefix}Left`)
      else if (!active) for (const code of codes) pressed.current.delete(code)
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (event.code === "Escape") { stopRecording(); return }
    if (event.repeat) return
    pressed.current.add(event.code)
    syncModifiers(event)
    if (event.metaKey || event.code.startsWith("Meta")) commandSeen.current = true
    const next = recordedShortcut(pressed.current)
    setKeys(next.keys)
    if (next.invalid) {
      invalidChord.current = true
      candidate.current = null
    } else if (!invalidChord.current && next.shortcut) candidate.current = next.shortcut
  }

  const handleKeyUp = (event: React.KeyboardEvent) => {
    event.preventDefault()
    event.stopPropagation()
    pressed.current.delete(event.code)
    syncModifiers(event)
    // macOS WebKit can omit the main keyup while Command is held.
    if (commandSeen.current && /^(Meta|Control|Alt|Shift)/.test(event.code) &&
      !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) pressed.current.clear()
    if (pressed.current.size !== 0) return
    if (candidate.current && !invalidChord.current) void apply(candidate.current)
    else {
      setKeys([])
      candidate.current = null
      invalidChord.current = false
      commandSeen.current = false
      setError("请按一个修饰键和一个字母或功能键。")
    }
  }

  const savedShortcut = status ? status.shortcut : globalShortcut
  const inactive = Boolean(savedShortcut && status && !status.active)
  const problem = error ?? status?.error

  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold">全局快捷键</h3>
      <div className={cn("flex min-h-12 items-center gap-2 rounded-lg bg-muted/50 p-2", recording && "ring-2 ring-primary")}>
        <Keyboard className="size-4 shrink-0 text-muted-foreground" />
        {recording ? (
          <div ref={recordingRef} role="textbox" aria-label="按下要设置的快捷键" tabIndex={0} onKeyDown={handleKeyDown} onKeyUp={handleKeyUp} onBlur={stopRecording} className="flex min-h-8 min-w-0 flex-1 items-center outline-none">
            {keys.length > 0 ? <Keycaps keys={keys} /> : <span className="text-sm text-muted-foreground">按下组合键</span>}
          </div>
        ) : (
          <Button type="button" variant="ghost" className="h-auto min-h-8 min-w-0 flex-1 justify-start px-1" disabled={busy} onClick={() => void startRecording()} aria-label={savedShortcut ? `编辑快捷键 ${savedShortcut}` : "设置快捷键"}>
            {savedShortcut ? <Keycaps keys={shortcutKeycaps(savedShortcut)} /> : "设置快捷键"}
          </Button>
        )}
        {busy ? <LoaderCircle className="size-4 animate-spin" aria-label="正在应用快捷键" /> : inactive ? <span className="flex shrink-0 items-center gap-1 text-xs text-amber-600"><TriangleAlert className="size-3.5" />未生效</span> : null}
        {recording ? <Button type="button" variant="ghost" size="icon-sm" aria-label="取消录制" onClick={stopRecording}><X className="size-4" /></Button> : savedShortcut ? <>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="录制新快捷键" disabled={busy} onClick={() => void startRecording()}><Pencil className="size-3.5" /></Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="清除快捷键" disabled={busy} onClick={() => void apply(null)}><X className="size-4" /></Button>
        </> : null}
      </div>
      {problem ? <p role="alert" className="mt-1.5 text-xs text-destructive">{problem}</p> : null}
    </section>
  )
}
