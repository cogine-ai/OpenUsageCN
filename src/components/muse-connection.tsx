import { useEffect, useRef, useState } from "react"
import { ArrowLeft, CheckCircle2, Clipboard, ExternalLink, LoaderCircle, RefreshCw } from "lucide-react"
import { openUrl } from "@tauri-apps/plugin-opener"
import { Button } from "@/components/ui/button"
import { useNowTicker } from "@/hooks/use-now-ticker"
import { cancelMuseLogin, pollMuseLogin, startMuseLogin, type MuseLoginSession } from "@/lib/muse-login"
import { getProviderConfig, PROVIDER_CONFIG_CHANGED } from "@/lib/provider-config"

type Phase = "loading" | "idle" | "starting" | "pending" | "checking" | "cancelling"

/** Maps native terminal states to fixed copy without exposing credential-bearing diagnostics. */
function loginFailure(error: unknown): string {
  const message = typeof error === "string" ? error : ""
  if (/expir|过期/i.test(message)) return "验证码已过期，请重新获取。"
  if (/denied|拒绝/i.test(message)) return "授权未完成，请在 Meta 页面允许后重新连接。"
  if (/config.*chang|配置.*变化|配置.*更新|凭据.*变化/i.test(message)) return "连接配置已更新，请重新连接。"
  if (/cancel|取消/i.test(message)) return "授权已取消，可重新连接。"
  return "连接暂不可用，请检查网络后重试。"
}

/** Connects Muse using explicit device authorization; saved credentials remain native-only. */
export function MuseConnection({ onBack, onSaved }: {
  onBack: () => void
  onSaved: (id: string) => Promise<void>
}) {
  const [phase, setPhase] = useState<Phase>("loading")
  const [configured, setConfigured] = useState(false)
  const [tokenExpiresAt, setTokenExpiresAt] = useState<number | null>(null)
  const [readFailed, setReadFailed] = useState(false)
  const [session, setSession] = useState<MuseLoginSession | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [verified, setVerified] = useState(false)
  const [copied, setCopied] = useState(false)
  const [slowed, setSlowed] = useState(false)
  const mounted = useRef(false)
  const revision = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const current = useRef<MuseLoginSession | null>(null)
  const onSavedRef = useRef(onSaved)
  useEffect(() => { onSavedRef.current = onSaved }, [onSaved])
  const now = useNowTicker({ enabled: Boolean(session || tokenExpiresAt), pauseWhenHidden: false })
  const expired = configured && tokenExpiresAt !== null && tokenExpiresAt <= now
  const waiting = phase === "starting" || phase === "pending" || phase === "cancelling"

  const stopTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }
  const release = (loginId: string) => {
    void cancelMuseLogin(loginId).catch(() => console.error("Failed to cancel Muse authorization"))
  }
  const read = async (expected: number) => {
    const view = await getProviderConfig("muse")
    if (!mounted.current || revision.current !== expected) return
    const saved = view.values.accessToken
    const expiry = view.values.tokenExpiresAt
    const expiryMs = expiry?.type === "text" && expiry.value ? Date.parse(expiry.value) : NaN
    setConfigured(saved?.type === "secret" && saved.configured)
    setTokenExpiresAt(Number.isFinite(expiryMs) ? expiryMs : null)
    setReadFailed(false)
  }
  const load = async () => {
    const expected = ++revision.current
    setPhase("loading"); setFailure(null)
    try { await read(expected) } catch {
      console.error("Failed to read Muse connection")
      if (mounted.current && revision.current === expected) { setReadFailed(true); setFailure("无法读取连接，请重试。") }
    } finally { if (mounted.current && revision.current === expected) setPhase("idle") }
  }
  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false; revision.current += 1; stopTimer()
      const previous = current.current; current.current = null
      if (previous) release(previous.loginId)
    }
  }, [])

  const check = async (expected: number) => {
    setPhase("checking"); setFailure(null)
    try {
      await onSavedRef.current("muse")
      if (!mounted.current || revision.current !== expected) return
      await read(expected)
      if (mounted.current && revision.current === expected) setVerified(true)
    } catch {
      console.error("Failed to check saved Muse connection")
      if (mounted.current && revision.current === expected) setFailure("连接已保存，用量检查未完成，请重试。")
    } finally { if (mounted.current && revision.current === expected) setPhase("idle") }
  }
  const schedule = (next: MuseLoginSession, expected: number, interval: number) => {
    stopTimer()
    timer.current = setTimeout(() => { void poll(next, expected, interval) }, Math.max(0, Math.min(interval * 1000, next.expiresAt - Date.now())))
  }
  const poll = async (next: MuseLoginSession, expected: number, interval: number) => {
    if (!mounted.current || revision.current !== expected) return
    if (Date.now() >= next.expiresAt) {
      current.current = null; setSession(null); setPhase("idle")
      setFailure("验证码已过期，请重新获取。"); release(next.loginId); return
    }
    try {
      const result = await pollMuseLogin(next.loginId)
      if (!mounted.current || revision.current !== expected) return
      if (result.state === "succeeded") {
        current.current = null; setSession(null); setConfigured(true)
        window.dispatchEvent(new CustomEvent(PROVIDER_CONFIG_CHANGED, { detail: "muse" }))
        await check(expected)
      } else {
        setSlowed(result.state === "slowDown")
        schedule(next, expected, result.intervalSeconds ?? interval)
      }
    } catch (error) {
      console.error("Failed to poll Muse authorization")
      if (!mounted.current || revision.current !== expected) return
      current.current = null; setSession(null); setPhase("idle"); setFailure(loginFailure(error)); release(next.loginId)
    }
  }
  const start = async () => {
    const expected = ++revision.current
    stopTimer(); setPhase("starting"); setFailure(null); setVerified(false); setCopied(false); setSlowed(false)
    try {
      const next = await startMuseLogin()
      if (!mounted.current || revision.current !== expected) { release(next.loginId); return }
      current.current = next; setSession(next); setPhase("pending"); schedule(next, expected, next.intervalSeconds)
    } catch (error) {
      console.error("Failed to start Muse authorization")
      if (mounted.current && revision.current === expected) { setPhase("idle"); setFailure(loginFailure(error)) }
    }
  }
  const cancel = async () => {
    const expected = ++revision.current
    stopTimer(); const previous = current.current; current.current = null; setSession(null); setPhase("cancelling"); setFailure(null)
    try { if (previous) await cancelMuseLogin(previous.loginId) } catch {
      console.error("Failed to cancel Muse authorization")
      if (mounted.current && revision.current === expected) setFailure("无法确认取消授权，请稍后重新连接。")
    } finally { if (mounted.current && revision.current === expected) setPhase("idle") }
  }
  const copy = async () => {
    if (!session) return
    const expected = revision.current
    try { await navigator.clipboard.writeText(session.userCode); if (mounted.current && revision.current === expected) setCopied(true) } catch {
      console.error("Failed to copy Muse authorization code")
      if (mounted.current && revision.current === expected) setFailure("无法复制，请手动输入验证码。")
    }
  }
  const open = async () => {
    if (!session) return
    const expected = revision.current
    try { await openUrl(session.verificationUri) } catch {
      console.error("Failed to open Meta authorization page")
      if (mounted.current && revision.current === expected) setFailure("无法打开 Meta 授权页面，请稍后重试。")
    }
  }
  const remaining = session ? Math.max(0, Math.ceil((session.expiresAt - now) / 1000)) : 0
  const busy = phase !== "idle"
  return <div className="space-y-5 py-3">
    <div className="flex items-center gap-2"><Button variant="ghost" size="icon-sm" aria-label="返回" onClick={onBack}><ArrowLeft className="size-4" /></Button><h2 className="text-base font-semibold">Muse Code · 连接</h2></div>
    <p className="text-sm leading-relaxed text-muted-foreground">在 Meta 授权页面输入验证码，连接 Muse Code 用量。</p>
    {phase === "loading" ? <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />正在读取连接</p> : session ? <section className="space-y-3 rounded-lg border bg-muted/50 p-4" aria-label="Meta 授权验证码">
      <p className="text-xs text-muted-foreground">在 Meta 页面输入验证码</p>
      <p className="select-all break-all text-2xl font-semibold tracking-widest tabular-nums">{session.userCode}</p>
      <Button variant="outline" className="h-10 w-full" onClick={() => void copy()}>{copied ? <CheckCircle2 className="size-4" /> : <Clipboard className="size-4" />}{copied ? "已复制" : "复制验证码"}</Button>
      <Button className="h-10 w-full" onClick={() => void open()}><ExternalLink className="size-4" />打开 Meta 授权网页</Button>
      <p role="status" className="text-xs text-muted-foreground">{slowed ? "Meta 正在处理授权，稍后自动检查" : "等待授权"} · 还有 <span className="tabular-nums">{Math.floor(remaining / 60)} 分 {remaining % 60} 秒</span></p>
    </section> : configured ? <div className="space-y-2 rounded-lg border bg-muted/50 p-4">
      <p className={`flex items-center gap-2 text-sm ${expired ? "text-amber-600 dark:text-amber-400" : verified ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}`}>{verified && !expired && <CheckCircle2 className="size-4" />}{expired ? "已保存的 Meta 连接已过期" : verified ? "Meta 连接已验证" : "已保存 Meta 连接"}</p>
      <p className="text-xs leading-relaxed text-muted-foreground">{expired ? "请重新授权以读取当前用量。" : "可以检查用量，或重新连接 Meta 账号。"}</p>
    </div> : !readFailed && <div className="space-y-3 text-sm"><p>1. 获取验证码并打开 Meta 授权网页。</p><p>2. 完成授权后，等待用量检查。</p></div>}
    <div className="space-y-2 border-t pt-3">
      {failure && <p role="alert" className="text-xs leading-relaxed text-destructive">{failure}</p>}
      {(phase === "starting" || phase === "checking" || phase === "cancelling") && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />{phase === "starting" ? "正在获取验证码" : phase === "checking" ? "正在检查用量" : "正在取消授权"}</p>}
      {waiting ? <Button variant="outline" className="h-10 w-full" disabled={phase === "cancelling"} onClick={() => void cancel()}>取消连接</Button> : readFailed ? <Button variant="outline" className="h-10 w-full" onClick={() => void load()}>重新读取连接</Button> : <>
        <Button className="h-10 w-full" disabled={busy} onClick={() => void start()}>{configured || failure ? "重新连接 Meta 账号" : "连接 Meta 账号"}</Button>
        {configured && !expired && <Button variant="outline" className="h-10 w-full" disabled={busy} onClick={() => void check(++revision.current)}><RefreshCw className="size-4" />检查已保存的连接</Button>}
      </>}
    </div>
  </div>
}
