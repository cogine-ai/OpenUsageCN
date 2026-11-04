import { useEffect, useRef, useState, type ReactNode } from "react"
import { ArrowLeft, KeyRound, LoaderCircle, Pencil, Plus, RefreshCw, Star } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { MetricLineRenderer } from "@/components/provider-metric"
import { ServerUsageReports } from "@/components/server-usage-reports"
import { OllamaAccountList, OllamaPrimaryBadge } from "@/components/ollama-account-list"
import { OllamaKeyForm } from "@/components/ollama-key-form"
import { useOllamaAccounts } from "@/hooks/use-ollama-accounts"
import { useNowTicker } from "@/hooks/use-now-ticker"
import { ollamaIdentityLabel, type OllamaVerification } from "@/lib/ollama-accounts"
import type { DisplayMode, ResetTimerDisplayMode, TimeFormatMode } from "@/lib/settings"

type Screen = "overview" | "keys" | "detail" | "form" | "legacy"

export function OllamaAccountsPage({
  initialScreen = "overview",
  legacyUsage,
  legacyConfiguration,
  onBack,
  onPrimaryChange,
  onQuotaRefresh,
  displayMode = "used",
  resetTimerDisplayMode = "relative",
  timeFormatMode = "auto",
}: {
  initialScreen?: "overview" | "keys"
  legacyUsage?: ReactNode
  legacyConfiguration?: ReactNode
  onBack?: () => void
  onPrimaryChange?: () => void
  onQuotaRefresh?: () => void
  displayMode?: DisplayMode
  resetTimerDisplayMode?: ResetTimerDisplayMode
  timeFormatMode?: TimeFormatMode
}) {
  const { view, loading, busy, error, reload, operate, save } = useOllamaAccounts(
    onPrimaryChange,
    onQuotaRefresh
  )
  const [screen, setScreen] = useState<Screen>(initialScreen)
  const [formOrigin, setFormOrigin] = useState<Screen>("keys")
  const [selected, setSelected] = useState<string | undefined>()
  const [editing, setEditing] = useState<string | undefined>()
  const [removing, setRemoving] = useState<string | undefined>()
  const [notice, setNotice] = useState("")
  const removalRef = useRef<HTMLDivElement>(null)
  const removalTrigger = useRef<HTMLElement | null>(null)
  const connection = view?.connections.find((item) => item.connectionId === selected)
  const edited = view?.connections.find((item) => item.connectionId === editing)
  const removed = view?.connections.find((item) => item.connectionId === removing)
  const primary = view?.primary.mode === "connection" && view.primary.connectionId === selected
  const connections = view?.connections ?? []
  const now = useNowTicker({
    enabled:
      screen === "detail" &&
      Boolean(connection?.snapshot?.lines.some((line) => line.type === "progress" && line.resetsAt)),
    intervalMs: 30_000,
  })
  useEffect(() => {
    if (!removed) return
    removalRef.current?.focus()
    removalRef.current?.scrollIntoView({ block: "nearest" })
  }, [removed?.connectionId])

  const navigate = (next: Screen) => {
    setScreen(next)
    setNotice("")
    setRemoving(undefined)
  }
  const add = () => {
    setEditing(undefined)
    setFormOrigin(screen)
    navigate("form")
  }
  const edit = (id: string) => {
    setEditing(id)
    setFormOrigin(screen)
    navigate("form")
  }
  const back = () => {
    if (screen === "form") navigate(formOrigin)
    else if (screen === "legacy") navigate("keys")
    else if (screen === initialScreen && onBack) onBack()
    else navigate("overview")
  }
  const selectPrimary = async (id: string) => {
    if (await operate({ kind: "selectPrimary", connectionId: id }))
      setNotice("已设为主账号，首页和菜单栏将显示此连接。")
  }
  const saveKey = async (verified: OllamaVerification, label: string) => {
    const next = await save(verified.verificationId, label, verified.differentAccount, editing)
    if (!next) return false
    navigate("keys")
    setNotice(
      verified.differentAccount
        ? "已添加新账号，原连接保持不变。"
        : editing
          ? "已验证并更新连接。"
          : "已添加连接，主账号未改变。"
    )
    return true
  }
  const title =
    screen === "keys"
      ? "Ollama Cloud · 连接"
      : screen === "detail" && connection
        ? connection.label
        : screen === "form"
          ? editing
            ? "更新 Key"
            : "添加 API Key"
          : screen === "legacy"
            ? "原有连接设置"
            : "Ollama Cloud"

  return (
    <div className="space-y-3 py-3">
      <header className="flex min-h-10 items-center gap-2">
        {screen !== "overview" || onBack ? (
          <Button type="button" variant="ghost" size="icon-sm" aria-label="返回" onClick={back}>
            <ArrowLeft className="size-4" />
          </Button>
        ) : null}
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold">{title}</h2>
        {screen === "overview" ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="刷新全部账号"
              disabled={busy || !connections.length}
              onClick={() => void operate({ kind: "refresh" })}
            >
              <RefreshCw className={busy ? "size-4 animate-spin" : "size-4"} />
            </Button>
            <Button type="button" variant="outline" onClick={() => navigate("keys")}>
              管理 Key
            </Button>
          </>
        ) : null}
        {screen === "keys" ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="添加 Key"
            disabled={busy}
            onClick={add}
          >
            <Plus className="size-4" />
          </Button>
        ) : null}
        {screen === "detail" && connection ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="刷新当前账号"
              disabled={busy}
              onClick={() =>
                void operate({ kind: "refresh", connectionId: connection.connectionId })
              }
            >
              <RefreshCw className={busy ? "size-4 animate-spin" : "size-4"} />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="编辑当前连接"
              disabled={busy}
              onClick={() => edit(connection.connectionId)}
            >
              <Pencil className="size-4" />
            </Button>
          </>
        ) : null}
      </header>
      {error ? (
        <div className="space-y-2">
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => void reload()}>
            重新读取连接
          </Button>
        </div>
      ) : null}
      {loading ? (
        <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          正在读取账号连接…
        </p>
      ) : null}

      {screen === "form" ? (
        editing && !edited ? (
          <p role="alert" className="text-xs text-destructive">
            此连接已被移除，请返回重新选择。
          </p>
        ) : (
          <OllamaKeyForm
            key={editing ?? "new"}
            connection={edited}
            busy={busy}
            onSave={saveKey}
            onRename={async (label) => {
              if (!editing || !(await operate({ kind: "rename", connectionId: editing, label })))
                return false
              navigate("keys")
              setNotice("连接名称已更新。")
              return true
            }}
          />
        )
      ) : screen === "legacy" ? (
        <div className="space-y-4">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Cookie、原有单个 API Key 和环境变量设置均保留。保存设置不会切换主账号。
          </p>
          {legacyConfiguration ?? (
            <p className="text-xs text-muted-foreground">
              在设置中打开 Ollama Cloud 以修改原有连接。
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={busy || view?.primary.mode === "legacy"}
            onClick={() =>
              void operate({ kind: "useLegacy" }).then((next) => {
                if (next) setNotice("首页和菜单栏已改用原有连接。")
              })
            }
          >
            将原有连接设为主账号
          </Button>
        </div>
      ) : screen === "detail" && connection ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="break-all text-xs text-muted-foreground">
              Ollama Cloud · {ollamaIdentityLabel(connection.identity)}
            </span>
            {connection.plan ? <Badge variant="outline">{connection.plan}</Badge> : null}
          </div>
          <p className="text-xs text-muted-foreground">
            读取连接 · {connection.label} · ••••{connection.keyHint}
          </p>
          {primary ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <OllamaPrimaryBadge />
              用于首页和菜单栏
            </div>
          ) : (
            <Button
              type="button"
              variant="outline"
              className="h-10 w-full"
              disabled={
                busy ||
                connection.error?.code === "authExpired" ||
                connection.error?.code === "identityChanged"
              }
              onClick={() => void selectPrimary(connection.connectionId)}
            >
              <Star className="size-4" />
              设为主账号
            </Button>
          )}
          {connection.error ? (
            <div role="alert" className="space-y-2 rounded-lg border p-3 text-xs">
              <p className="text-destructive">{connection.error.message}</p>
              {connection.snapshot ? (
                <p className="text-muted-foreground">本次未更新，下方保留上次成功读取的数据。</p>
              ) : null}
              {connection.error.code === "authExpired" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => edit(connection.connectionId)}
                >
                  更新 Key
                </Button>
              ) : null}
            </div>
          ) : null}
          {connection.snapshot ? (
            <section aria-label="账户额度" className="space-y-3 pt-2">
              {connection.snapshot.lines.map((line, index) => (
                <MetricLineRenderer
                  key={`${line.label}-${index}`}
                  line={line}
                  displayMode={displayMode}
                  resetTimerDisplayMode={resetTimerDisplayMode}
                  timeFormatMode={timeFormatMode}
                  now={now}
                  refreshing={busy}
                  stale={Boolean(connection.error)}
                  lastUpdatedAt={
                    connection.lastUpdatedAt ? Date.parse(connection.lastUpdatedAt) : null
                  }
                />
              ))}
            </section>
          ) : (
            <p className="text-xs text-muted-foreground">尚未读取到额度，请刷新此账号。</p>
          )}
          {connection.lastUpdatedAt ? (
            <p className="text-xs text-muted-foreground">
              额度更新于{" "}
              <time dateTime={connection.lastUpdatedAt}>
                {new Date(connection.lastUpdatedAt).toLocaleString()}
              </time>
            </p>
          ) : null}
          <ServerUsageReports
            key={`${connection.connectionId}:${connection.revision}:${connection.lastUpdatedAt}:${busy}`}
            providerId="ollama"
            connectionId={connection.connectionId}
            sourceRefreshing={busy}
          />
        </>
      ) : (
        <>
          {screen === "keys" ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">API Keys</h3>
                <span className="text-xs text-muted-foreground">{connections.length} 个连接</span>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                每个 Key 单独命名，验证后显示账号归属。已有 Key 只显示尾号。
              </p>
            </>
          ) : connections.length ? (
            <p className="text-xs text-muted-foreground">账户用量 · {connections.length} 个连接</p>
          ) : null}
          {view ? (
            <OllamaAccountList
              view={view}
              busy={busy}
              managing={screen === "keys"}
              onSelect={(id) => {
                setSelected(id)
                navigate("detail")
              }}
              onPrimary={(id) => void selectPrimary(id)}
              onEdit={edit}
              onRemove={(id) => {
                removalTrigger.current = document.activeElement as HTMLElement
                setRemoving(id)
              }}
              onAdd={add}
            />
          ) : null}
          {removed ? (
            <div
              ref={removalRef}
              tabIndex={-1}
              role="group"
              aria-label={`确认移除 ${removed.label}`}
              className="space-y-3 rounded-lg border p-3"
            >
              <p className="break-all text-sm font-medium">移除「{removed.label}」？</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                只从 OpenUsageCN 移除连接和缓存，不会在 Ollama 撤销 Key。
                {view?.primary.connectionId === removed.connectionId
                  ? "移除后不自动选择其他账号，首页和菜单栏将暂不显示 Ollama 用量。"
                  : "其他账号连接保持不变。"}
              </p>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setRemoving(undefined)
                    removalTrigger.current?.focus()
                  }}
                >
                  取消
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={busy}
                  onClick={() =>
                    void operate({ kind: "remove", connectionId: removed.connectionId }).then(
                      (next) => {
                        if (next) {
                          setRemoving(undefined)
                          setNotice("已从本机移除，未撤销 Ollama Key。")
                        }
                      }
                    )
                  }
                >
                  从本机移除
                </Button>
              </div>
            </div>
          ) : null}
          {view?.primary.mode === "none" ? (
            <p className="text-xs text-muted-foreground">
              尚未设置主账号。请选择一个连接，首页和菜单栏不会自动切换到其他账号。
            </p>
          ) : view?.primary.mode === "legacy" && connections.length ? (
            <p className="text-xs text-muted-foreground">
              主账号仍使用原有 Cookie、单个 API Key 或环境变量连接。
            </p>
          ) : null}
          {connections.length ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              各连接显示其可读取的账户用量，不计算总额。同一用户的多个 Key 可能共享额度。
            </p>
          ) : null}
          {screen === "keys" ? (
            <details className="border-t pt-3">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                其他连接方式
              </summary>
              <div className="space-y-3 pt-3">
                <p className="text-xs leading-relaxed text-muted-foreground">
                  保留原有 Cookie、单个 API Key 和环境变量配置。
                </p>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => navigate("legacy")}
                >
                  <KeyRound className="size-4" />
                  管理原有连接
                </Button>
              </div>
            </details>
          ) : view?.primary.mode === "legacy" ? (
            <section aria-label="当前首页连接" className="space-y-2 border-t pt-3">
              <h3 className="text-xs font-medium text-muted-foreground">当前首页连接 · 原有设置</h3>
              {legacyUsage}
            </section>
          ) : null}
        </>
      )}
      {notice ? (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}
    </div>
  )
}
