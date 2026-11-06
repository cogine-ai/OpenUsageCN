import { ollamaIdentityLabel, type OllamaAccountsView } from "@/lib/ollama-accounts"

/** Makes default consumers explicit where the default connection is selected. */
export function OllamaDefaultAccount({ view, busy, onSelect, onLegacy }: {
  view: OllamaAccountsView
  busy: boolean
  onSelect: (connectionId: string) => void
  onLegacy: () => void
}) {
  const value = view.primary.mode === "connection"
    ? `connection:${view.primary.connectionId}`
    : view.primary.mode === "legacy" ? "legacy" : ""
  return (
    <label className="block space-y-2 rounded-lg border p-3">
      <span className="text-xs font-medium">菜单栏 / API 默认账号</span>
      <select
        className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
        value={value}
        disabled={busy}
        onChange={(event) => {
          const next = event.target.value
          if (next === value) return
          if (next === "legacy") onLegacy()
          else if (next.startsWith("connection:")) onSelect(next.slice("connection:".length))
        }}
      >
        {view.primary.mode === "none" ? <option value="" disabled>未设置</option> : null}
        {view.connections.map((connection) => (
          <option key={connection.connectionId} value={`connection:${connection.connectionId}`}
            disabled={connection.error?.code === "authExpired" || connection.error?.code === "identityChanged"}>
            {connection.label} · {ollamaIdentityLabel(connection.identity)}
          </option>
        ))}
        <option value="legacy" disabled={!view.legacy.configured || view.legacy.error?.code === "authExpired" || view.legacy.error?.code === "identityChanged"}>
          原有连接{view.legacy.configured ? "" : " · 未配置"}
        </option>
      </select>
    </label>
  )
}
