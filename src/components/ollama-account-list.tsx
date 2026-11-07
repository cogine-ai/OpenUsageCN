import { Ellipsis, KeyRound, Pencil, Star, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  OllamaUsageCard,
  OllamaPrimaryBadge,
  type OllamaDisplayPreferences,
} from "@/components/ollama-usage-card"
import {
  ollamaIdentityLabel,
  type OllamaAccountsView,
  type OllamaConnection,
} from "@/lib/ollama-accounts"

export function OllamaConnectionStatus({ connection }: { connection: OllamaConnection }) {
  return (
    <span className={connection.error ? "text-destructive" : "text-muted-foreground"}>
      {connection.error
        ? connection.error.code === "authExpired"
          ? "Key 已失效"
          : connection.error.code === "permissionDenied"
            ? "访问受限"
            : connection.error.code === "rateLimited"
              ? "请求过于频繁"
              : connection.error.code === "identityChanged"
                ? "账号身份变化"
                : "本次未更新"
        : "可用"}
    </span>
  )
}

/** Shows quota cards in the usage view and connection controls in account management. */
export function OllamaAccountList({
  view,
  busy,
  managing,
  onSelect,
  onPrimary,
  onEdit,
  onRemove,
  onAdd,
  onLegacySelect,
  onLegacyEdit,
  onLegacyPrimary,
  refreshing = false,
  ...preferences
}: OllamaDisplayPreferences & {
  view: OllamaAccountsView
  busy: boolean
  managing: boolean
  onSelect: (id: string) => void
  onPrimary: (id: string) => void
  onEdit: (id: string) => void
  onRemove: (id: string) => void
  onAdd: () => void
  onLegacySelect: () => void
  onLegacyEdit: () => void
  onLegacyPrimary: () => void
  refreshing?: boolean
}) {
  const legacy = view.legacy
  const showLegacy = managing || legacy.configured || Boolean(legacy.error)
  if (!managing && !view.connections.length && !showLegacy)
    return (
      <div className="space-y-3 py-6 text-center">
        <KeyRound className="mx-auto size-7 text-muted-foreground" />
        <h3 className="text-sm font-semibold">添加 Ollama Cloud 连接</h3>
        <p className="text-xs text-muted-foreground">添加 API Key 或配置原有 Cookie 连接。</p>
        <Button type="button" onClick={onAdd}>
          添加连接
        </Button>
      </div>
    )
  return (
    <div className="space-y-3">
      {view.connections.map((connection) => {
        const primary =
          view.primary.mode === "connection" &&
          view.primary.connectionId === connection.connectionId
        const identity = ollamaIdentityLabel(connection.identity)
        if (!managing)
          return (
            <OllamaUsageCard
              key={connection.connectionId}
              {...connection}
              {...preferences}
              identity={`${identity} · API Key`}
              namedConnection
              primary={primary}
              refreshing={refreshing}
              onSelect={() => onSelect(connection.connectionId)}
            />
          )
        return (
          <div
            key={connection.connectionId}
            className="flex items-start gap-2 rounded-lg border p-3"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="break-all text-sm font-semibold">{connection.label}</span>
                {primary ? <OllamaPrimaryBadge /> : null}
              </div>
              <p className="mt-2 break-all text-xs text-muted-foreground">
                ••••{connection.keyHint} · {identity}
              </p>
              <p className="mt-1 text-xs">
                <OllamaConnectionStatus connection={connection} />
              </p>
            </div>
            <details className="relative shrink-0">
              <summary
                aria-label={`${connection.label}连接操作`}
                className="flex size-10 cursor-pointer list-none items-center justify-center rounded-md hover:bg-muted [&::-webkit-details-marker]:hidden"
              >
                <Ellipsis className="size-4" />
              </summary>
              <div className="absolute right-0 top-10 z-10 w-44 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
                <Button
                  type="button"
                  variant="ghost"
                  className="h-10 w-full justify-start"
                  disabled={
                    busy ||
                    primary ||
                    connection.error?.code === "authExpired" ||
                    connection.error?.code === "identityChanged"
                  }
                  onClick={() => onPrimary(connection.connectionId)}
                >
                  <Star className="size-4" />
                  设为主账号
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-10 w-full justify-start"
                  disabled={busy}
                  onClick={() => onEdit(connection.connectionId)}
                >
                  <Pencil className="size-4" />
                  修改名称 / Key
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-10 w-full justify-start text-destructive"
                  disabled={busy}
                  onClick={() => onRemove(connection.connectionId)}
                >
                  <Trash2 className="size-4" />
                  移除连接
                </Button>
              </div>
            </details>
          </div>
        )
      })}
      {showLegacy ? (
        managing ? (
          <div className="space-y-2 rounded-lg border p-3" aria-label="原有连接设置">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">原有连接</span>
              {view.primary.mode === "legacy" ? <OllamaPrimaryBadge /> : null}
            </div>
            <p className="text-xs text-muted-foreground">
              {legacy.source === "apiKey" ? "API Key" : "Cookie"} ·{" "}
              {legacy.configured ? "已配置" : legacy.error ? "状态不可读" : "未配置"}
            </p>
            {legacy.error ? (
              <p role="alert" className="text-xs text-destructive">
                {legacy.error.message}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" disabled={busy} onClick={onLegacyEdit}>
                <Pencil className="size-4" />
                管理原有连接
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={busy || !legacy.configured || view.primary.mode === "legacy"}
                onClick={onLegacyPrimary}
              >
                <Star className="size-4" />
                设为主账号
              </Button>
            </div>
          </div>
        ) : (
          <OllamaUsageCard
            {...legacy}
            {...preferences}
            label="原有连接"
            identity={
              legacy.source === "apiKey" ? "原有 API Key / 环境变量连接" : "Cookie / 环境变量连接"
            }
            plan={legacy.snapshot?.plan}
            primary={view.primary.mode === "legacy"}
            refreshing={refreshing}
            onSelect={onLegacySelect}
          />
        )
      ) : null}
    </div>
  )
}
