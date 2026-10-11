import { useEffect, useRef, useState } from "react"
import { CheckCircle2, ChevronDown, KeyRound, LoaderCircle, RefreshCw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { compactFieldClassName } from "@/components/ui/field"
import type { PluginConfigField } from "@/lib/plugin-types"
import { deleteProviderConfigField, getProviderConfig, saveProviderConfig, type ProviderConfigView } from "@/lib/provider-config"
import { configDraft, effectiveSelections, visibleConfigFields } from "@/lib/provider-config-presentation"
import { getPluginRecovery } from "@/lib/plugin-recovery"
import { cn } from "@/lib/utils"

type Props = {
  pluginId: string
  fields: PluginConfigField[]
  initialView?: ProviderConfigView | null
  focusField?: string
  onSaved: (pluginId: string) => Promise<void>
}

/** Edits visible connection fields and reports persistence separately from fresh verification. */
export function ProviderConfigFields({ pluginId, fields, initialView, focusField, onSaved }: Props) {
  /** Opens the method containing the requested field while preserving the other draft values. */
  const focusedDraft = (next: ProviderConfigView | null) => {
    const values = configDraft(fields, next)
    const condition = fields.find((field) => field.id === focusField)?.visibleWhen
    if (condition) values[condition.field] = condition.values[0]
    return values
  }
  const [view, setView] = useState<ProviderConfigView | null>(initialView ?? null)
  const [draft, setDraft] = useState(() => focusedDraft(initialView ?? null))
  const [phase, setPhase] = useState<"loading" | "idle" | "saving" | "checking" | "connected" | "failed">(initialView ? "idle" : "loading")
  const [error, setError] = useState<string | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [persisted, setPersisted] = useState<false | "saved" | "cleared">(false)
  const [reload, setReload] = useState(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    let cancelled = false
    if (!initialView) {
      setPhase("loading")
      getProviderConfig(pluginId).then((next) => {
        if (cancelled) return
        setView(next); setDraft(focusedDraft(next)); setPhase("idle")
      }).catch((err) => {
        console.error("Failed to load provider config:", err)
        if (!cancelled) { setError("无法加载连接配置，请重试。"); setPhase("failed") }
      })
    }
    return () => { cancelled = true; mounted.current = false }
  }, [pluginId, fields, initialView, reload])
  useEffect(() => {
    if (phase !== "loading" && focusField) document.getElementById(`${pluginId}-${focusField}`)?.focus()
  }, [phase, pluginId, focusField])

  const busy = !view || ["loading", "saving", "checking"].includes(phase)
  const selections = effectiveSelections(fields, draft, view)
  const visible = visibleConfigFields(fields, selections)
  const incomplete = visible.some((field) => {
    const saved = view?.values[field.id]
    return field.required && !String(draft[field.id] ?? "").trim() &&
      !(saved?.type === "secret" && saved.configured) && !view?.environment?.[field.id]?.configured
  })
  const invalidSelection = fields.some((field) => field.type === "select" && !selections[field.id])
  /** Updates an unsaved field and invalidates the previous verification result. */
  const edit = (id: string, value: string | boolean) => {
    setDraft((current) => ({ ...current, [id]: value }))
    setPhase("idle"); setError(null); setPersisted(false)
  }
  /** Marks the connection successful only after the supplied verification completes. */
  const check = async () => {
    setPhase("checking")
    await onSaved(pluginId)
    if (mounted.current) setPhase("connected")
  }
  /** Persists visible fields, retains other drafts, and then verifies the saved connection. */
  const save = async () => {
    setError(null); setPersisted(false); setPhase("saving")
    let saved = false
    try {
      await saveProviderConfig(pluginId, Object.fromEntries(visible.map((field) => [field.id, draft[field.id] ?? ""])))
      saved = true
      if (mounted.current) { setPersisted("saved"); setPhase("checking") }
      // Start verification immediately after persistence, even if the page closes.
      const [next, result] = await Promise.allSettled([getProviderConfig(pluginId), onSaved(pluginId)])
      if (mounted.current && next.status === "fulfilled") {
        setView(next.value)
        const refreshed = configDraft(fields, next.value)
        // Refresh submitted fields while retaining unsaved input for other methods.
        setDraft((current) => ({ ...current, ...Object.fromEntries(visible.map((field) => [field.id, refreshed[field.id]])) }))
      }
      if (result.status === "rejected") throw result.reason
      if (next.status === "rejected") throw next.reason
      if (mounted.current) setPhase("connected")
    } catch (err) {
      console.error("Failed to save or verify provider config:", err)
      if (mounted.current) { setError(saved ? getPluginRecovery(String(err), pluginId).title : "保存失败，请重试。"); setPhase("failed") }
    }
  }
  /** Deletes one saved credential and verifies the remaining connection sources. */
  const clear = async (fieldId: string) => {
    setPhase("saving"); setError(null)
    let deleted = false
    try {
      await deleteProviderConfigField(pluginId, fieldId)
      deleted = true
      if (mounted.current) { setPersisted("cleared"); setPhase("checking") }
      const [next, result] = await Promise.allSettled([getProviderConfig(pluginId), onSaved(pluginId)])
      if (mounted.current && next.status === "fulfilled") { setView(next.value); setDraft(configDraft(fields, next.value)) }
      if (result.status === "rejected") throw result.reason
      if (next.status === "rejected") throw next.reason
      if (mounted.current) setPhase("connected")
    } catch (err) {
      console.error("Failed to clear provider config:", err)
      if (mounted.current) { setError(deleted ? getPluginRecovery(String(err), pluginId).title : "无法清除凭据，请重试。"); setPhase("failed") }
    }
  }
  /** Verifies the already saved connection without persisting the current draft. */
  const recheck = async () => {
    setError(null)
    try { await check() } catch (err) {
      console.error("Failed to verify saved provider config:", err)
      if (mounted.current) { setError(getPluginRecovery(String(err), pluginId).title); setPhase("failed") }
    }
  }

  return <div className="space-y-5 pb-3">
    {phase === "loading" && <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在读取连接</div>}
    {view?.environmentError && <p role="alert" className="text-xs text-destructive">{view.environmentError}</p>}
    {visible.map((field) => {
      const inputId = `${pluginId}-${field.id}`
      const saved = view?.values[field.id]
      const env = view?.environment?.[field.id]
      const invalidEnvironment = Boolean(field.autoValue && draft[field.id] === field.autoValue && field.environmentVariables?.length && env?.configured && !selections[field.id])
      const options = field.options.filter((option) => option.value !== field.autoValue)
      return <div key={field.id} className="space-y-2">
        <label htmlFor={inputId} className="block text-xs font-medium">{field.label}</label>
        {field.type === "select" && options.length <= 4 ? <div id={inputId} role="radiogroup" aria-label={field.label} className="flex gap-2">
          {options.map((option) => <Button key={option.value} type="button" role="radio" aria-checked={selections[field.id] === option.value} variant={selections[field.id] === option.value ? "default" : "outline"} className="min-w-0 flex-1" disabled={busy} onClick={() => edit(field.id, option.value)}>{field.id === "source" && option.value === "api-key" && <KeyRound className="size-4" />}{option.label}</Button>)}
        </div> : field.type === "select" ? <select id={inputId} value={String(draft[field.id])} disabled={busy} onChange={(event) => edit(field.id, event.target.value)} className={cn(compactFieldClassName, "w-full")}>{field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : null}
        {invalidEnvironment && <p role="alert" className="text-xs text-destructive">环境地区无效，请选择地区。</p>}
        {(field.type === "secret" || field.type === "text") && <div className="flex min-w-0 gap-2">
          <input id={inputId} type={field.type === "secret" ? "password" : "text"} autoComplete="off" aria-required={field.required || undefined} value={String(draft[field.id] ?? "")} placeholder={saved?.type === "secret" && saved.configured ? `已保存 ${saved.hint ?? ""}`.trim() : env?.configured ? `已读取 ${env.name}` : field.placeholder} disabled={busy} onChange={(event) => edit(field.id, event.target.value)} className={cn(compactFieldClassName, "w-full min-w-0 flex-1")} />
          {saved?.type === "secret" && saved.configured && <Button type="button" variant="ghost" size="icon-sm" aria-label={`清除 ${field.label}`} disabled={busy} onClick={() => void clear(field.id)}><Trash2 className="size-4" /></Button>}
        </div>}
        {field.type === "toggle" && <input id={inputId} type="checkbox" checked={Boolean(draft[field.id])} disabled={busy} onChange={(event) => edit(field.id, event.target.checked)} />}
      </div>
    })}
    {(fields.some((field) => field.autoValue || field.help || field.environmentVariables?.length) || Object.keys(view?.environment ?? {}).length > 0) && <div className="border-t pt-3">
      <button type="button" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)} className="flex w-full items-center justify-between text-xs text-muted-foreground">高级设置<ChevronDown className={cn("size-4 transition-transform", advanced && "rotate-180")} /></button>
      {advanced && <div className="mt-3 space-y-3 text-xs text-muted-foreground">
        {fields.filter((field) => field.autoValue).map((field) => <label key={field.id} className="flex items-center gap-2"><input type="checkbox" checked={draft[field.id] === field.autoValue} disabled={busy} onChange={(event) => edit(field.id, event.target.checked ? field.autoValue! : selections[field.id])} />自动读取{field.label}</label>)}
        {visible.filter((field) => field.type === "secret").map((field) => {
          const saved = view?.values[field.id]
          const selector = fields.find((candidate) => candidate.id === field.visibleWhen?.field)
          const unknownSource = Boolean(field.environmentVariables?.length &&
            [...field.environmentVariables, ...(selector?.environmentVariables ?? [])].some((name) => view?.environmentUnresolved?.includes(name)))
          const sourceStatus = saved?.type === "secret" && saved.configured ? "已保存"
            : view?.environment?.[field.id]?.configured ? view.environment[field.id].name : unknownSource ? "环境来源未确认"
              : field.environmentVariables?.length ? "未发现凭据" : "尚未检查外部来源"
          return <div key={field.id} className="flex items-center justify-between gap-2"><span>{field.label}</span><span>{sourceStatus}</span></div>
        })}
        {visible.filter((field) => field.help).map((field) => <details key={field.id}><summary className="cursor-pointer">{field.label}帮助</summary><p className="mt-1 select-text leading-relaxed">{field.help}</p></details>)}
      </div>}
    </div>}
    <div className="space-y-2 border-t pt-3">
      <div role="status" aria-live="polite" className="flex items-center gap-2 text-xs">
        {phase === "connected" ? <><CheckCircle2 className="size-4 text-green-600" />连接成功</> : phase === "checking" ? <><LoaderCircle className="size-4 animate-spin" />{persisted === "cleared" ? "已清除" : "已保存"} · 正在检查连接</> : error ? <span role="alert" className="text-destructive">{persisted ? `${persisted === "cleared" ? "已清除" : "已保存"} · ` : ""}{error}</span> : persisted ? "已保存 · 尚未检查连接" : null}
      </div>
      {!view && phase === "failed" && <Button variant="outline" className="w-full" onClick={() => setReload((value) => value + 1)}>重新读取配置</Button>}
      <Button className="h-10 w-full" disabled={busy || incomplete || invalidSelection || fields.length === 0} onClick={() => void save()}>{busy && <LoaderCircle className="size-4 animate-spin" />}{phase === "saving" ? "正在保存" : phase === "checking" ? "正在检查连接" : "保存并检查"}</Button>
      {persisted && phase === "failed" && <Button variant="outline" className="w-full" disabled={busy} onClick={() => void recheck()}><RefreshCw className="size-4" />重新检查已保存的连接</Button>}
    </div>
  </div>
}
