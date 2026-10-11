import { useEffect, useRef, useState } from "react"
import {
  AlertTriangle, ArrowLeft, Check, ChevronRight, CircleX, Globe,
  LoaderCircle, Plus, RefreshCw, Search, X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  cancelBrowserDiscovery, discoverBrowserAccounts, listBrowserProfiles,
  type BrowserAccountCandidate, type BrowserAccountDiscovery, type BrowserAccountProviderId,
  type BrowserName, type BrowserProfile,
} from "@/lib/browser-accounts"
import type { ProviderAccountOperationReceipt } from "@/lib/plugin-types"

type BrowserAccountManagerProps = {
  busy: boolean
  providerId?: BrowserAccountProviderId
  standalone?: boolean
  onClose?: () => void
  onAttach: (candidateId: string) => Promise<ProviderAccountOperationReceipt | null>
}
type BrowserUiError = { message: string; code: string }
function browserError(cause: unknown, fallback: string): BrowserUiError {
  const code = typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string" ? cause.code : "unknown"
  const messages: Record<string, string> = {
    authenticationRejected: "此配置文件没有可用的登录", cookieReadFailed: "无法读取此浏览器的登录",
    profileDiscoveryFailed: "无法读取浏览器配置文件", providerValidationFailed: "无法确认账号身份",
    timedOut: "检查超时", overallTimedOut: "部分来源检查超时", invalidResponse: "无法确认账号身份", identityUnavailable: "无法确认账号身份",
    cancelled: "检查已取消", candidateExpired: "检查结果已过期", candidateNotFound: "需要重新检查此来源",
  }
  return { code, message: messages[code] ?? fallback }
}
export function BrowserAccountManager({ busy, providerId = "cursor", standalone = false, onClose, onAttach }: BrowserAccountManagerProps) {
  const mounted = useRef(true)
  const activeRequestId = useRef<string | null>(null)
  const profileRevision = useRef(0)
  const [open, setOpen] = useState(standalone)
  const [browser, setBrowser] = useState<BrowserName | null>(null)
  const [profiles, setProfiles] = useState<BrowserProfile[]>([])
  const [listed, setListed] = useState(false)
  const [loadingProfiles, setLoadingProfiles] = useState(false)
  const [profileKey, setProfileKey] = useState("")
  const [discovery, setDiscovery] = useState<BrowserAccountDiscovery | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [invalidIds, setInvalidIds] = useState<Set<string>>(new Set())
  const [scanning, setScanning] = useState(false)
  const [attaching, setAttaching] = useState(false)
  const [error, setError] = useState<BrowserUiError | null>(null)
  const [now, setNow] = useState(Date.now)
  const title = providerId === "claude" ? "连接浏览器" : "添加账号"
  const candidates = discovery?.profiles.flatMap((result) => result.candidate ? [result.candidate] : []) ?? []
  const selected = candidates.find((candidate) => candidate.candidateId === selectedId)
  const needsCheck = selected && (invalidIds.has(selected.candidateId) || selected.expiresAtMs <= now)
  const blocked = busy || attaching

  function cancelRequest(requestId: string) {
    void cancelBrowserDiscovery(requestId).catch(() => console.error("Failed to cancel browser discovery"))
  }
  function cancelScan() {
    const requestId = activeRequestId.current
    activeRequestId.current = null
    if (requestId) cancelRequest(requestId)
    setScanning(false)
  }
  function close() {
    profileRevision.current += 1
    cancelScan()
    setOpen(false)
    setBrowser(null)
    setProfiles([])
    setListed(false)
    setLoadingProfiles(false)
    setDiscovery(null)
    setSelectedId(null)
    setError(null)
    onClose?.()
  }
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      profileRevision.current += 1
      if (activeRequestId.current) cancelRequest(activeRequestId.current)
      activeRequestId.current = null
    }
  }, [])
  useEffect(() => {
    const expires = candidates.map((candidate) => candidate.expiresAtMs).filter((expiresAt) => expiresAt > Date.now())
    if (expires.length === 0) return
    const timer = setTimeout(() => setNow(Date.now()), Math.min(...expires) - Date.now() + 1)
    return () => clearTimeout(timer)
  }, [discovery, now])
  async function chooseBrowser(nextBrowser: BrowserName) {
    const revision = ++profileRevision.current
    cancelScan()
    setBrowser(nextBrowser)
    setProfiles([])
    setListed(false)
    setDiscovery(null)
    setSelectedId(null)
    setError(null)
    setLoadingProfiles(true)
    try {
      const response = await listBrowserProfiles(nextBrowser)
      if (mounted.current && profileRevision.current === revision) {
        setProfiles(response.profiles)
        setListed(true)
      }
    } catch (cause) {
      if (!mounted.current || profileRevision.current !== revision) return
      const nextError = browserError(cause, "无法读取浏览器配置文件")
      console.error("Failed to list browser profiles", nextError.code)
      setError(nextError)
    } finally {
      if (mounted.current && profileRevision.current === revision) setLoadingProfiles(false)
    }
  }
  async function scanProfile(targetKey: string, preserve = false) {
    if (!browser || blocked) return
    cancelScan()
    const requestId = crypto.randomUUID()
    activeRequestId.current = requestId
    setProfileKey(targetKey)
    setError(null)
    setScanning(true)
    if (!preserve) {
      setDiscovery(null)
      setSelectedId(null)
    }
    try {
      const request = { requestId, providerId, browser }
      const response = await discoverBrowserAccounts(targetKey === "all" ? request : { ...request, profileKey: targetKey })
      if (!mounted.current || activeRequestId.current !== requestId) return
      setDiscovery(response)
      const first = response.profiles.find((result) => result.status === "verified" && (result.candidate?.identity?.email || result.candidate?.identity?.name))
      setSelectedId(first?.candidate?.candidateId ?? null)
      setNow(Date.now())
    } catch (cause) {
      if (!mounted.current || activeRequestId.current !== requestId) return
      const nextError = browserError(cause, "账号检查失败")
      console.error("Failed to discover browser account", nextError.code)
      setError(nextError)
    } finally {
      if (mounted.current && activeRequestId.current === requestId) {
        activeRequestId.current = null
        setScanning(false)
      }
    }
  }
  async function attach(candidate: BrowserAccountCandidate) {
    if (blocked || scanning) return
    if (invalidIds.has(candidate.candidateId) || candidate.expiresAtMs <= Date.now()) {
      setNow(Date.now())
      return
    }
    setAttaching(true)
    setError(null)
    try {
      const receipt = await onAttach(candidate.candidateId)
      if (!mounted.current) return
      if (receipt && receipt.status !== "failed") close()
      else {
        setInvalidIds((current) => new Set(current).add(candidate.candidateId))
        setError({ code: receipt?.error?.code ?? "attachFailed", message: "连接未完成，请重新检查此来源" })
        console.error("Failed to attach browser account", receipt?.error?.code ?? "attachFailed")
      }
    } catch {
      if (!mounted.current) return
      console.error("Failed to attach browser account")
      setInvalidIds((current) => new Set(current).add(candidate.candidateId))
      setError({ code: "attachFailed", message: "连接未完成，请重新检查此来源" })
    } finally {
      if (mounted.current) setAttaching(false)
    }
  }
  const profileName = (key: string) => profiles.find((profile) => profile.profileKey === key)?.displayName ?? key
  if (!open) {
    return (
      <Button size="sm" variant="outline" disabled={busy} onClick={() => setOpen(true)}>
        <Plus className="size-4" />{title}
      </Button>
    )
  }
  return (
    <div className={standalone ? "flex min-h-0 flex-col gap-4" : "space-y-4"}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="关闭账号连接"
          disabled={blocked} onClick={close}>
          <X className="size-4" />
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2" role="group" aria-label="浏览器">
        {(["Chrome", "Arc"] as const).map((option) => (
          <Button key={option} variant={browser === option ? "default" : "outline"}
            aria-pressed={browser === option} disabled={blocked} onClick={() => void chooseBrowser(option)}>
            <Globe className="size-4" />{option}
          </Button>
        ))}
      </div>
      {loadingProfiles ? (
        <div role="status" className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />正在读取配置文件…
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/30 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /><span>{error.message}</span>
        </div>
      ) : null}
      {browser && listed && !loadingProfiles && !discovery ? (
        <div className="space-y-2">
          {profiles.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">没有找到配置文件</p>
          ) : profiles.map((profile) => (
            <Button key={profile.profileKey} type="button" variant="outline"
              className="h-auto min-h-12 w-full justify-between py-3 text-left" disabled={blocked || scanning}
              onClick={() => void scanProfile(profile.profileKey)}>
              <span className="min-w-0 break-words">{profile.displayName}</span>
              <ChevronRight className="size-4 shrink-0" />
            </Button>
          ))}
          {providerId === "cursor" && profiles.length > 1 ? (
            <Button variant="ghost" className="w-full" disabled={blocked || scanning}
              onClick={() => void scanProfile("all")}>
              <Search className="size-4" />查找此浏览器全部账号
            </Button>
          ) : null}
        </div>
      ) : null}
      {scanning ? (
        <div role="status" className="flex items-center justify-between gap-2 rounded-md bg-muted/50 p-3 text-sm">
          <span className="flex items-center gap-2"><LoaderCircle className="size-4 animate-spin" />正在检查账号…</span>
          <Button size="sm" variant="ghost" onClick={cancelScan}>取消</Button>
        </div>
      ) : null}
      {discovery ? (
        <div className="space-y-2">
          {discovery.partial ? (
            <p className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle className="size-4" />部分来源暂时不可用
            </p>
          ) : null}
          <div role="radiogroup" aria-label="发现的账号" className="space-y-2" onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) return
            const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="radio"]:not(:disabled)'))
            const index = options.indexOf(event.target as HTMLButtonElement)
            if (index < 0 || options.length === 0) return
            event.preventDefault()
            const direction = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1
            const next = options[(index + direction + options.length) % options.length]
            next.focus()
            next.click()
          }}>
            {discovery.profiles.map((result) => {
              const candidate = result.candidate
              const identity = candidate?.identity?.email || candidate?.identity?.name
              const verified = result.status === "verified" && candidate && identity
              const label = identity || (result.status === "empty" ? "未登录" : result.status === "verified" ? "身份未确认" : "检查失败")
              const content = (
                <>
                  <div className="min-w-0 flex-1">
                    <p className="break-all font-medium">{label}</p>
                    {candidate?.identity?.email && candidate.identity.name ? (
                      <p className="break-words text-xs text-muted-foreground">{candidate.identity.name}</p>
                    ) : null}
                    <p className="mt-1 truncate text-xs text-muted-foreground">{browser} · {profileName(result.profileKey)}</p>
                    {result.error ? (
                      <p className="mt-1 text-xs text-destructive">{browserError(result.error, "无法确认账号身份").message}</p>
                    ) : null}
                    {candidate && (invalidIds.has(candidate.candidateId) || candidate.expiresAtMs <= now) ? (
                      <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">需要重新检查</p>
                    ) : null}
                  </div>
                  {verified && selectedId === candidate.candidateId ? (
                    <Check className="size-4 shrink-0" />
                  ) : !verified ? <CircleX className="size-4 shrink-0 text-muted-foreground" /> : null}
                </>
              )
              return verified ? (
                <button key={result.profileKey} type="button" role="radio"
                  tabIndex={selectedId === candidate.candidateId ? 0 : -1}
                  aria-checked={selectedId === candidate.candidateId} disabled={blocked || scanning}
                  onClick={() => setSelectedId(candidate.candidateId)}
                  className={`flex w-full items-center gap-3 rounded-lg border p-3 text-left text-sm focus-visible:outline-2 focus-visible:outline-ring ${selectedId === candidate.candidateId ? "border-primary bg-primary/5" : "border-border"}`}>
                  {content}
                </button>
              ) : (
                <div key={result.profileKey} className="flex items-center gap-3 rounded-lg border border-border p-3 text-sm">{content}</div>
              )
            })}
          </div>
          <Button variant="ghost" size="sm" disabled={blocked || scanning} onClick={() => {
            setDiscovery(null)
            setSelectedId(null)
            setError(null)
          }}>
            <ArrowLeft className="size-4" />选择其他配置
          </Button>
        </div>
      ) : null}
      {selected ? (
        <Button className="h-10 w-full" disabled={blocked || scanning}
          onClick={() => needsCheck ? void scanProfile(selected.profileKey, true) : void attach(selected)}>
          {blocked || scanning ? <LoaderCircle className="size-4 animate-spin" /> : needsCheck ? <RefreshCw className="size-4" /> : <Plus className="size-4" />}
          {attaching ? "正在连接…" : needsCheck ? "重新检查此来源" : providerId === "claude" ? "连接所选浏览器" : "添加所选账号"}
        </Button>
      ) : discovery && !scanning ? (
        <Button className="h-10 w-full" variant="outline" disabled={blocked} onClick={() => void scanProfile(profileKey)}>
          <RefreshCw className="size-4" />重新检查此来源
        </Button>
      ) : null}
    </div>
  )
}
