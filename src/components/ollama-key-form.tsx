import { useEffect, useRef, useState } from "react"
import { CheckCircle2, Eye, EyeOff, LoaderCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  ollamaIdentityLabel,
  verifyOllamaKey,
  type OllamaConnection,
  type OllamaVerification,
} from "@/lib/ollama-accounts"

const INPUT_CLASS =
  "h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60"

export function OllamaKeyForm({
  connection,
  busy,
  onSave,
  onRename,
}: {
  connection?: OllamaConnection
  busy: boolean
  onSave: (verified: OllamaVerification, label: string) => Promise<boolean>
  onRename: (label: string) => Promise<boolean>
}) {
  const [label, setLabel] = useState(connection?.label ?? "")
  const [apiKey, setApiKey] = useState("")
  const [visible, setVisible] = useState(false)
  const [checking, setChecking] = useState(false)
  const [verified, setVerified] = useState<OllamaVerification | null>(null)
  const [error, setError] = useState<string | null>(null)
  const revision = useRef(0)
  useEffect(
    () => () => {
      revision.current += 1
    },
    []
  )

  const verify = async () => {
    const current = ++revision.current
    setChecking(true)
    setError(null)
    setVerified(null)
    try {
      const result = await verifyOllamaKey(apiKey.trim(), connection?.connectionId)
      if (revision.current !== current) return
      setVerified(result)
      setApiKey("")
      setVisible(false)
    } catch (reason) {
      console.error("Failed to verify Ollama API key")
      if (revision.current === current)
        setError(
          typeof reason === "string" && reason.trim()
            ? reason
            : "无法验证 Key，请检查 Key、网络和账号权限后重试。原有连接保持不变。"
        )
    } finally {
      if (revision.current === current) setChecking(false)
    }
  }

  return (
    <div className="space-y-4">
      {connection ? <p className="text-xs leading-relaxed text-muted-foreground">
        新 Key 验证成功并确认后才替换原连接。留空可只修改名称。
      </p> : null}
      {!connection ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">额度说明</summary>
          <p className="mt-2 leading-relaxed">同一账号的多个 Key 可能共享额度。各连接分别展示，不计算合计。</p>
        </details>
      ) : null}
      <label className="block space-y-2">
        <span className="text-sm font-medium">名称</span>
        <input
          className={INPUT_CLASS}
          value={label}
          maxLength={40}
          autoComplete="off"
          placeholder="如：个人、工作、备用"
          disabled={busy || checking || Boolean(verified)}
          onChange={(event) => setLabel(event.target.value)}
        />
      </label>
      <label className="block space-y-2">
        <span className="text-sm font-medium">API Key</span>
        <div className="relative">
          <input
            className={`${INPUT_CLASS} pr-11`}
            type={visible ? "text" : "password"}
            autoComplete="new-password"
            spellCheck={false}
            placeholder={verified ? `已验证 · ••••${verified.keyHint}` : "粘贴 Ollama API Key"}
            value={apiKey}
            disabled={busy || checking || Boolean(verified)}
            onChange={(event) => {
              revision.current += 1
              setApiKey(event.target.value)
              setVerified(null)
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            className="absolute right-0 top-0"
            aria-label={visible ? "隐藏新输入的 Key" : "显示新输入的 Key"}
            disabled={Boolean(verified)}
            onClick={() => setVisible(!visible)}
          >
            {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </Button>
        </div>
      </label>
      {connection ? (
        <p className="text-xs text-muted-foreground">
          当前连接 · ••••{connection.keyHint} · {ollamaIdentityLabel(connection.identity)}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {verified ? (
        <>
          <section aria-label="已验证账号" className="space-y-2 rounded-lg bg-muted p-3">
            <h3 className="flex items-center gap-2 break-all text-sm font-semibold">
              <CheckCircle2 className="size-4 shrink-0" />
              识别到 {ollamaIdentityLabel(verified.identity)}
            </h3>
            {verified.identity.email && verified.identity.name ? (
              <p className="break-all text-xs text-muted-foreground">{verified.identity.email}</p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {verified.plan ? `${verified.plan} · ` : ""}已读取账户额度
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {verified.differentAccount
                ? "此 Key 属于另一个用户，将新增连接，原账号不替换。"
                : verified.sameAccount
                  ? "与已有连接属于同一用户，可能读取相同额度；保留独立连接，不计算合计。"
                  : "确认账号归属后再保存。"}
            </p>
          </section>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-10 flex-1"
              disabled={busy}
              onClick={() => {
                setVerified(null)
                setError(null)
              }}
            >
              重新输入
            </Button>
            <Button
              type="button"
              className="h-10 flex-1"
              disabled={busy || !label.trim()}
              onClick={() => {
                const current = revision.current
                void onSave(verified, label.trim()).then((saved) => {
                  if (!saved && revision.current === current) {
                    setVerified(null)
                    setError("未能保存连接，请重新输入并验证 Key。")
                  }
                })
              }}
            >
              {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {verified.differentAccount ? "作为新账号添加" : connection ? "确认替换" : "确认添加"}
            </Button>
          </div>
        </>
      ) : (
        <Button
          type="button"
          className="h-10 w-full"
          disabled={busy || checking || !label.trim() || (!connection && !apiKey.trim())}
          onClick={() => {
            if (connection && !apiKey.trim()) void onRename(label.trim())
            else void verify()
          }}
        >
          {checking ? <LoaderCircle className="size-4 animate-spin" /> : null}
          {checking ? "正在验证…" : connection && !apiKey.trim() ? "保存名称" : "验证 Key"}
        </Button>
      )}
      <p className="text-xs leading-relaxed text-muted-foreground">
        已有 Key 只显示尾号。验证失败时，不覆盖或切换其他连接。
      </p>
    </div>
  )
}
