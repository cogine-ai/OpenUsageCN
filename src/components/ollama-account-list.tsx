import { ChevronRight, Ellipsis, KeyRound, Pencil, Star, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  ollamaIdentityLabel,
  type OllamaAccountsView,
  type OllamaConnection,
} from "@/lib/ollama-accounts"

export function OllamaPrimaryBadge() {
  return (
    <Badge variant="secondary" className="gap-1">
      <Star className="size-3" />
      主账号
    </Badge>
  )
}

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

export function OllamaAccountList({
  view,
  busy,
  managing,
  onSelect,
  onPrimary,
  onEdit,
  onRemove,
  onAdd,
}: {
  view: OllamaAccountsView
  busy: boolean
  managing: boolean
  onSelect: (id: string) => void
  onPrimary: (id: string) => void
  onEdit: (id: string) => void
  onRemove: (id: string) => void
  onAdd: () => void
}) {
  if (!view.connections.length)
    return (
      <div className="space-y-3 py-6 text-center">
        <KeyRound className="mx-auto size-7 text-muted-foreground" />
        <h3 className="text-sm font-semibold">添加第一个账号</h3>
        <p className="text-xs text-muted-foreground">粘贴 API Key，核对账号后查看额度。</p>
        <Button type="button" onClick={onAdd}>
          添加 Key
        </Button>
      </div>
    )
  return (
    <div className="space-y-2">
      {view.connections.map((connection) => {
        const primary =
          view.primary.mode === "connection" &&
          view.primary.connectionId === connection.connectionId
        const monthly = connection.snapshot?.lines.find(
          (line) => line.type === "progress" && line.label === "Monthly"
        )
        const progress = monthly?.type === "progress" ? monthly : undefined
        const identity = ollamaIdentityLabel(connection.identity)
        const content = (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="break-all font-semibold">{connection.label}</span>
                {primary ? <OllamaPrimaryBadge /> : null}
              </span>
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                {connection.plan}
                {!managing ? <ChevronRight className="size-4" /> : null}
              </span>
            </div>
            {managing ? (
              <>
                <p className="mt-2 break-all text-xs text-muted-foreground">
                  ••••{connection.keyHint} · {identity}
                </p>
                <p className="mt-1 text-xs">
                  <OllamaConnectionStatus connection={connection} />
                </p>
              </>
            ) : (
              <>
                {progress ? (
                  <>
                    <div className="mt-2 flex items-baseline justify-between gap-2 text-xs">
                      <span className="text-muted-foreground">
                        {connection.error ? "上次读取的月度用量" : "月度已用"}
                      </span>
                      <span className="tabular-nums">
                        {progress.format.kind === "dollars" ? "$" : ""}
                        {progress.used.toLocaleString(undefined, {
                          maximumFractionDigits: 2,
                        })} / {progress.format.kind === "dollars" ? "$" : ""}
                        {progress.limit.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        {progress.format.kind === "percent" ? "%" : ""}
                      </span>
                    </div>
                    <div className="my-2 h-1.5 overflow-hidden rounded-full bg-secondary">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{
                          width: `${Math.min(100, Math.max(0, progress.limit > 0 ? (progress.used / progress.limit) * 100 : 0))}%`,
                        }}
                      />
                    </div>
                  </>
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {connection.snapshot ? "查看额度详情" : "额度暂不可读"}
                  </p>
                )}
                <div className="mt-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span className="break-all">{identity}</span>
                  {connection.error ? (
                    <OllamaConnectionStatus connection={connection} />
                  ) : connection.lastUpdatedAt ? (
                    <time dateTime={connection.lastUpdatedAt}>
                      {new Date(connection.lastUpdatedAt).toLocaleString()}
                    </time>
                  ) : null}
                </div>
              </>
            )}
          </>
        )
        return managing ? (
          <div
            key={connection.connectionId}
            className="flex items-start gap-2 rounded-lg border p-3"
          >
            <div className="min-w-0 flex-1">{content}</div>
            <details className="relative shrink-0">
              <summary
                aria-label={`${connection.label}连接操作`}
                className="flex size-9 cursor-pointer list-none items-center justify-center rounded-md hover:bg-muted [&::-webkit-details-marker]:hidden"
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
        ) : (
          <button
            type="button"
            key={connection.connectionId}
            aria-label={`查看${connection.label}用量`}
            className="w-full rounded-lg border p-3 text-left text-sm transition-colors hover:bg-muted/50 focus-visible:outline-ring"
            onClick={() => onSelect(connection.connectionId)}
          >
            {content}
          </button>
        )
      })}
    </div>
  )
}
