import { useState } from "react"
import { openUrl } from "@tauri-apps/plugin-opener"
import { ArrowLeft, CheckCircle2, Clipboard, LoaderCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ProviderConfigFields } from "@/components/provider-config-fields"
import { ProviderAccountControls } from "@/components/provider-account-controls"
import { useAppUiStore } from "@/stores/app-ui-store"
import type { SettingsPluginConfig } from "@/components/settings-plugin-item"

const LOCAL_STEPS: Record<string, { command?: string; step: string }> = {
  claude: { command: "claude", step: "在终端打开 Claude Code，输入 /login 完成登录。" },
  codex: { command: "codex login", step: "在终端完成 Codex 登录。" },
  kimi: { command: "kimi login", step: "在终端完成 Kimi 登录。" },
  factory: { command: "droid", step: "在终端打开 Droid，按提示登录。" },
  "opencode-go": { command: "opencode", step: "在 OpenCode 中连接 Go 账号。" },
  copilot: { command: "gh auth login", step: "在终端完成 GitHub 登录。" },
  grok: { command: "grok login", step: "在终端完成 Grok 登录。" },
  gemini: { command: "gemini", step: "在 Gemini CLI 中按提示完成登录。" },
  kiro: { step: "在 Kiro 中重新登录。" },
  amp: { step: "在 Amp Code 中重新登录。" },
  antigravity: { step: "在 Antigravity 中重新登录。" },
  perplexity: { step: "在 Perplexity 应用中重新登录。" },
  cursor: { step: "在 Cursor 中登录，然后重新检查本机账号。" },
}

function LocalConnection({ plugin, error, onCheck }: { plugin: SettingsPluginConfig; error?: string | null; onCheck: (id: string) => Promise<void> }) {
  const [phase, setPhase] = useState<"idle" | "checking" | "done">("idle")
  const [failure, setFailure] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const localPermission = /credentials could not be read|EACCES|(?:file|keychain|local).*permission/i.test(error ?? "")
  const accountPermission = !localPermission && /subscription|HTTP\s*403|forbidden|access denied/i.test(error ?? "")
  const accountLink = plugin.links?.find((link) => /^https:\/\//.test(link.url) && /billing|usage|account|console|dashboard/i.test(link.url))
  const fileStorage = plugin.id === "codex" && /Windows requires Codex file storage/i.test(error ?? "")
  const steps = LOCAL_STEPS[plugin.id]
  const check = async () => {
    setPhase("checking"); setFailure(null)
    try { await onCheck(plugin.id); setPhase("done") } catch (err) { console.error("Failed to check local connection:", err); setPhase("idle"); setFailure("尚未连上，请检查登录和读取权限后重试。") }
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(steps!.command!); setCopied(true) } catch (err) { console.error("Failed to copy login command:", err); setFailure("无法复制，请手动输入命令。") }
  }
  return <div className="space-y-4">
    <p className="text-sm leading-relaxed">{accountPermission ? "在服务商控制台检查当前账号的订阅和访问权限，然后检查连接。" : localPermission ? "允许 OpenUsageCN 读取本机登录文件或钥匙串，再检查连接。" : steps?.step ?? "在服务商应用完成登录或设置凭据，然后检查连接。"}</p>
    {fileStorage && <p className="select-text text-sm">先在 Codex 的 config.toml 设置 <code>cli_auth_credentials_store = "file"</code>。</p>}
    {accountPermission && accountLink && <Button variant="outline" className="w-full" onClick={() => void openUrl(accountLink.url).catch((cause) => { console.error("Failed to open account page:", cause); setFailure("无法打开服务商页面。") })}>打开服务商控制台</Button>}
    {!localPermission && !accountPermission && steps?.command && <div className="flex items-center justify-between rounded-lg border bg-muted/30 p-3"><code className="select-text text-sm">{steps.command}</code><Button variant="ghost" size="icon-sm" aria-label={copied ? "已复制" : "复制登录命令"} onClick={() => void copy()}>{copied ? <CheckCircle2 className="size-4" /> : <Clipboard className="size-4" />}</Button></div>}
    <Button className="h-10 w-full" disabled={phase === "checking"} onClick={() => void check()}>{phase === "checking" && <LoaderCircle className="size-4 animate-spin" />}{phase === "checking" ? "正在检查连接" : "检查连接"}</Button>
    <div role="status" className="text-xs">{phase === "done" ? "连接成功" : failure && <span role="alert" className="text-destructive">{failure}</span>}</div>
  </div>
}

export function ProviderConnectionPage({ plugin, error, onCheck, onAccountChangeRefresh }: {
  plugin: SettingsPluginConfig | null
  error?: string | null
  onCheck: (id: string) => Promise<void>
  onAccountChangeRefresh: (id: string) => void
}) {
  const { connection, closeConnection, openConnection } = useAppUiStore()
  if (!connection || !plugin) return <Button variant="ghost" onClick={closeConnection}><ArrowLeft className="size-4" />返回</Button>
  return <div className="space-y-5 py-3">
    <div className="flex items-center gap-2"><Button variant="ghost" size="icon-sm" aria-label="返回" onClick={closeConnection}><ArrowLeft className="size-4" /></Button><h2 className="min-w-0 truncate text-base font-semibold">{plugin.name} · {connection.kind === "accounts" ? "账号" : "连接"}</h2></div>
    {connection.kind === "config" && plugin.config ? <ProviderConfigFields key={plugin.id} pluginId={plugin.id} fields={plugin.config.fields} focusField={connection.focusField} onSaved={onCheck} /> : connection.kind === "accounts" && plugin.accountSupport ? <ProviderAccountControls key={plugin.id} providerId={plugin.id} browserBinding={plugin.accountSupport.browserBinding} modelHistory={false} standalone onOpenLocalLogin={() => openConnection(plugin.id, "local")} onAccountChangeRefresh={() => onAccountChangeRefresh(plugin.id)} /> : <LocalConnection key={plugin.id} plugin={plugin} error={error} onCheck={onCheck} />}
  </div>
}
