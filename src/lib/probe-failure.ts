import type { PluginOutput } from "@/lib/plugin-types"

export function probeFailure(output: PluginOutput): string | null {
  const failure = output.lines.find((line) => line.type === "badge" && line.label === "Error")
  if (failure?.type === "badge") return failure.text || "无法更新数据，请重试。"
  // Claude returns cached quota with a Status badge when the live API is limited.
  if (output.providerId === "claude" && output.lines.some((line) =>
    line.type === "badge" && line.label === "Status" && /^Rate limited/i.test(line.text))) {
    return "服务商暂时限制请求；当前数据来自上次读取。请稍后重试。"
  }
  return null
}
