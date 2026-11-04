import { useEffect, useRef, useState, type ReactNode } from "react"
import { ArrowLeft, LoaderCircle, Pencil, Plus, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { OllamaAccountDetail } from "@/components/ollama-account-detail"
import { OllamaAccountList } from "@/components/ollama-account-list"
import { OllamaKeyForm } from "@/components/ollama-key-form"
import { useOllamaAccounts } from "@/hooks/use-ollama-accounts"
import { type OllamaAccountSelection, type OllamaVerification } from "@/lib/ollama-accounts"
import type { DisplayMode, ResetTimerDisplayMode, TimeFormatMode } from "@/lib/settings"

type Screen = "overview" | "keys" | "detail" | "form" | "legacy" | "legacyDetail"

export function OllamaAccountsPage({
  initialScreen = "overview",
  legacyConfiguration,
  onBack,
  onPrimaryChange,
  allRefreshing = false,
  initialAccount,
  onAccountBack,
  displayMode = "used",
  resetTimerDisplayMode = "relative",
  timeFormatMode = "auto",
}: {
  initialScreen?: "overview" | "keys"
  legacyConfiguration?: ReactNode
  onBack?: () => void
  onPrimaryChange?: () => void
  allRefreshing?: boolean
  initialAccount?: OllamaAccountSelection | null
  onAccountBack?: () => void
  displayMode?: DisplayMode
  resetTimerDisplayMode?: ResetTimerDisplayMode
  timeFormatMode?: TimeFormatMode
}) {
  const { view, loading, busy, refreshing, error, reload, operate, save } =
    useOllamaAccounts(onPrimaryChange)
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
  const visibleCount =
    connections.length + Number(view?.legacy.configured || Boolean(view?.legacy.error))
  const legacyDetail = screen === "legacyDetail"
  const reportSourceRefreshing =
    allRefreshing ||
    refreshing?.kind === "all" ||
    (legacyDetail
      ? refreshing?.kind === "legacy"
      : refreshing?.kind === "connection" && refreshing.connectionId === selected)
  useEffect(() => {
    if (!initialAccount) return
    setSelected(initialAccount.kind === "connection" ? initialAccount.connectionId : undefined)
    setScreen(initialAccount.kind === "legacy" ? "legacyDetail" : "detail")
  }, [initialAccount])
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
    else {
      onAccountBack?.()
      navigate("overview")
    }
  }
  const selectPrimary = async (id: string) => {
    if (await operate({ kind: "selectPrimary", connectionId: id }))
      setNotice("已设为主账号，菜单栏和本地 API 将使用此连接。")
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
            : screen === "legacyDetail"
              ? "原有连接"
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
              disabled={busy || allRefreshing || !(connections.length || view?.legacy.configured)}
              onClick={() => void operate({ kind: "refresh" })}
            >
              <RefreshCw className={busy ? "size-4 animate-spin" : "size-4"} />
            </Button>
            <Button type="button" variant="outline" onClick={() => navigate("keys")}>
              管理账号
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
        {(screen === "detail" && connection) || legacyDetail ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="刷新当前账号"
              disabled={busy}
              onClick={() =>
                void operate(
                  legacyDetail
                    ? { kind: "refreshLegacy" }
                    : { kind: "refresh", connectionId: connection!.connectionId }
                )
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
              onClick={() => (legacyDetail ? navigate("legacy") : edit(connection!.connectionId))}
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
            disabled={busy || !view?.legacy.configured || view?.primary.mode === "legacy"}
            onClick={() =>
              void operate({ kind: "useLegacy" }).then((next) => {
                if (next) setNotice("菜单栏和本地 API 已改用原有连接。")
              })
            }
          >
            将原有连接设为主账号
          </Button>
        </div>
      ) : view && ((screen === "detail" && connection) || legacyDetail) ? (
        <OllamaAccountDetail
          account={
            legacyDetail
              ? { kind: "legacy", value: view.legacy }
              : { kind: "connection", value: connection! }
          }
          primary={legacyDetail ? view.primary.mode === "legacy" : primary}
          busy={busy}
          refreshing={Boolean(reportSourceRefreshing)}
          onPrimary={() =>
            legacyDetail
              ? void operate({ kind: "useLegacy" })
              : void selectPrimary(connection!.connectionId)
          }
          onEdit={() => (legacyDetail ? navigate("legacy") : edit(connection!.connectionId))}
          displayMode={displayMode}
          resetTimerDisplayMode={resetTimerDisplayMode}
          timeFormatMode={timeFormatMode}
        />
      ) : (
        <>
          {screen === "keys" ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">账号连接</h3>
                <span className="text-xs text-muted-foreground">
                  {connections.length + 1} 个连接
                </span>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                每个 Key 单独命名，验证后显示账号归属。已有 Key 只显示尾号。
              </p>
            </>
          ) : visibleCount ? (
            <p className="text-xs text-muted-foreground">账户用量 · {visibleCount} 个连接</p>
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
              onLegacySelect={() => navigate("legacyDetail")}
              onLegacyEdit={() => navigate("legacy")}
              onLegacyPrimary={() => void operate({ kind: "useLegacy" })}
              displayMode={displayMode}
              resetTimerDisplayMode={resetTimerDisplayMode}
              timeFormatMode={timeFormatMode}
              refreshing={busy || allRefreshing}
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
                  ? "移除后不自动选择其他主账号，菜单栏和本地 API 将暂不显示 Ollama 用量。"
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
              尚未设置主账号。菜单栏和本地 API 不会自动切换到其他账号；首页仍展示所有连接。
            </p>
          ) : view?.primary.mode === "legacy" && connections.length ? (
            <p className="text-xs text-muted-foreground">
              主账号仍使用原有连接，仅影响菜单栏和本地 API。
            </p>
          ) : null}
          {connections.length ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              各连接显示其可读取的账户用量，不计算总额。同一用户的多个 Key 可能共享额度。
            </p>
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
