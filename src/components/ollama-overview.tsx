import { LoaderCircle, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { OllamaAccountList } from "@/components/ollama-account-list"
import type { OllamaDisplayPreferences } from "@/components/ollama-usage-card"
import { useOllamaAccounts } from "@/hooks/use-ollama-accounts"
import { useAppUiStore } from "@/stores/app-ui-store"

/** A single provider group exposes every connection; primary selection stays a secondary setting. */
export function OllamaOverview({
  refreshing = false,
  showSeparator,
  ...preferences
}: OllamaDisplayPreferences & { refreshing?: boolean; showSeparator: boolean }) {
  const { view, loading, busy, error, reload, operate } = useOllamaAccounts()
  const openConnection = useAppUiStore((state) => state.openConnection)
  const openAccount = useAppUiStore((state) => state.openOllamaAccount)
  const manage = () => openConnection("ollama", "accounts")
  const count = view
    ? view.connections.length + Number(view.legacy.configured || Boolean(view.legacy.error))
    : 0
  return (
    <section aria-label="Ollama Cloud" className="space-y-3 py-3">
      <header className="flex min-h-10 items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Ollama Cloud</h2>
        <Button type="button" variant="outline" onClick={manage}>
          管理账号
        </Button>
      </header>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{count} 个连接</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy || refreshing || !count}
          onClick={() => void operate({ kind: "refresh" })}
          aria-label="刷新全部账号"
        >
          <RefreshCw className={busy || refreshing ? "size-4 animate-spin" : "size-4"} />
          刷新全部
        </Button>
      </div>
      {loading ? (
        <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          正在读取账号连接…
        </p>
      ) : null}
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
      {view ? (
        <OllamaAccountList
          view={view}
          busy={busy || refreshing}
          managing={false}
          {...preferences}
          refreshing={busy || refreshing}
          onSelect={(connectionId) => openAccount({ kind: "connection", connectionId })}
          onLegacySelect={() => openAccount({ kind: "legacy" })}
          onAdd={manage}
          onPrimary={manage}
          onEdit={manage}
          onRemove={manage}
          onLegacyEdit={manage}
          onLegacyPrimary={manage}
        />
      ) : null}
      {count ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          各连接显示其可读取的账户用量，不计算总额。同一用户的多个 Key 可能共享额度。
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">主账号用于菜单栏和本地 API，不影响首页展示。</p>
      {showSeparator ? <div className="border-b border-border pt-1" /> : null}
    </section>
  )
}
