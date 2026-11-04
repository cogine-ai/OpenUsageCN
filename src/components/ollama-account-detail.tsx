import { Star } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  OllamaQuota,
  OllamaPrimaryBadge,
  type OllamaDisplayPreferences,
} from "@/components/ollama-usage-card"
import { ServerUsageReports } from "@/components/server-usage-reports"
import {
  ollamaIdentityLabel,
  type OllamaConnection,
  type OllamaLegacyConnection,
} from "@/lib/ollama-accounts"

type Account =
  | { kind: "connection"; value: OllamaConnection }
  | { kind: "legacy"; value: OllamaLegacyConnection }

/** The viewed connection owns quota and reports; the primary action only changes default consumers. */
export function OllamaAccountDetail({
  account,
  primary,
  busy,
  refreshing,
  onPrimary,
  onEdit,
  ...preferences
}: OllamaDisplayPreferences & {
  account: Account
  primary: boolean
  busy: boolean
  refreshing: boolean
  onPrimary: () => void
  onEdit: () => void
}) {
  const data = account.value
  const named = account.kind === "connection" ? account.value : null
  const legacy = account.kind === "legacy" ? account.value : null
  const reportKey = `${named?.connectionId ?? "legacy"}:${data.revision}:${data.lastUpdatedAt}:${refreshing}`
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="break-all text-xs text-muted-foreground">
          Ollama Cloud ·{" "}
          {named
            ? ollamaIdentityLabel(named.identity)
            : legacy?.source === "apiKey"
              ? "原有 API Key / 环境变量连接"
              : "Cookie / 环境变量连接"}
        </span>
        {data.snapshot?.plan ? <Badge variant="outline">{data.snapshot.plan}</Badge> : null}
      </div>
      {named ? (
        <p className="text-xs text-muted-foreground">
          读取连接 · {named.label} · ••••{named.keyHint}
        </p>
      ) : null}
      {primary ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <OllamaPrimaryBadge />
          用于菜单栏和本地 API
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          className="h-10 w-full"
          disabled={
            busy ||
            Boolean(legacy && !legacy.configured) ||
            data.error?.code === "authExpired" ||
            data.error?.code === "identityChanged"
          }
          onClick={onPrimary}
        >
          <Star className="size-4" />
          设为主账号
        </Button>
      )}
      {data.error?.code === "authExpired" ? (
        <Button type="button" variant="outline" size="sm" onClick={onEdit}>
          {named ? "更新 Key" : "更新连接"}
        </Button>
      ) : null}
      <OllamaQuota {...data} {...preferences} refreshing={refreshing} />
      {legacy?.source === "cookie" ? (
        <p className="text-xs text-muted-foreground">
          Cookie 连接不提供模型报告；可在连接设置中选择 API Key。
        </p>
      ) : (
        <ServerUsageReports
          key={reportKey}
          providerId="ollama"
          connectionId={named?.connectionId}
          useLegacy={Boolean(legacy)}
          sourceRefreshing={refreshing}
        />
      )}
    </>
  )
}
