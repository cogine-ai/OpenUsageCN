import { describe, expect, it } from "vitest"
import type { PluginOutput } from "@/lib/plugin-types"
import { getTrayProviderText } from "./tray-provider-value"

function output(providerId: string, lines: PluginOutput["lines"]): PluginOutput {
  return { providerId, displayName: providerId, iconUrl: "", lines }
}

describe("getTrayProviderText", () => {
  it("keeps real quota percentages ahead of balance text", () => {
    expect(getTrayProviderText("openrouter", 0.42, output("openrouter", [
      { type: "text", label: "Balance", value: "$4.84" },
    ]))).toBe("42%")
  })

  it("shows provider-reported balances without calculating a percentage", () => {
    expect(getTrayProviderText("openrouter", undefined, output("openrouter", [
      { type: "text", label: "Balance", value: "$4.84" },
    ]))).toBe("$4.84")
    expect(getTrayProviderText("moonshot", undefined, output("moonshot", [
      { type: "text", label: "Available Balance", value: "¥21.30" },
    ]))).toBe("¥21.30")
    expect(getTrayProviderText("xai", undefined, output("xai", [
      { type: "text", label: "Prepaid Balance", value: "$0.00" },
      { type: "text", label: "30D Spend", value: "$4.30" },
    ]))).toBe("$0.00")
  })

  it("selects a positive DeepSeek currency and leaves both in the provider data", () => {
    const data = output("deepseek", [
      { type: "text", label: "CNY Balance", value: "¥0.00" },
      { type: "text", label: "USD Balance", value: "$3.50" },
    ])
    expect(getTrayProviderText("deepseek", undefined, data)).toBe("$3.50")
    expect(data.lines).toHaveLength(2)
  })

  it("shows only the logo when neither a quota nor a balance is available", () => {
    expect(getTrayProviderText("deepseek", undefined, null)).toBe("")
    expect(getTrayProviderText("openrouter", undefined, output("openrouter", [
      { type: "badge", label: "Status", text: "No usage data" },
    ]))).toBe("")
    expect(getTrayProviderText("codex", undefined, null)).toBe("")
  })
})
