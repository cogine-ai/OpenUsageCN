import type { PluginOutput } from "@/lib/plugin-types"
import { formatTrayPercentText } from "@/lib/tray-tooltip"

// These labels are the balance lines emitted by the bundled providers.
const BALANCE_LABELS: Record<string, readonly string[]> = {
  deepseek: ["CNY Balance", "USD Balance"],
  moonshot: ["Available Balance"],
  openrouter: ["Balance"],
  xai: ["Prepaid Balance"],
}

export function getTrayProviderText(
  providerId: string,
  fraction: number | undefined,
  data: PluginOutput | null,
): string {
  const percent = formatTrayPercentText(fraction)
  if (percent) return percent

  const labels = BALANCE_LABELS[providerId]
  if (!labels || !data) return ""

  const balances = labels.flatMap((label) => {
    const line = data.lines.find((item) => item.type === "text" && item.label === label)
    return line?.type === "text" && line.value.trim() ? [line.value.trim()] : []
  })
  if (providerId === "deepseek") {
    // Keep one currency in the narrow menu bar. Prefer a positive CNY balance,
    // then a positive USD balance; the provider card still shows both.
    return balances.find((value) => Number(value.replace(/[^\d.-]/g, "")) > 0) ?? balances[0] ?? ""
  }
  return balances[0] ?? ""
}
