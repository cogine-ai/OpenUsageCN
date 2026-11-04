import { describe, expect, it } from "vitest"
import antigravity from "../../plugins/antigravity/plugin.json"
import openrouter from "../../plugins/openrouter/plugin.json"
import perplexity from "../../plugins/perplexity/plugin.json"
import { getTrayPrimaryBars } from "./tray-primary-progress"
import type { MetricLine, PluginMeta } from "./plugin-types"

function bar(manifest: typeof antigravity | typeof openrouter | typeof perplexity, names: string[], preferWeekly = false) {
  const lines = manifest.lines as Array<{ label: string; type: string; primaryOrder?: number; period?: string }>
  const meta = {
    id: manifest.id, name: manifest.name, iconUrl: "", lines: manifest.lines,
    primaryCandidates: lines.filter((line) => line.primaryOrder !== undefined).sort((a, b) => a.primaryOrder! - b.primaryOrder!).map((line) => line.label),
    weeklyCandidate: lines.find((line) => line.period === "weekly")?.label,
  } as PluginMeta
  return getTrayPrimaryBars({
    pluginsMeta: [meta], pluginSettings: { order: [manifest.id], disabled: [] },
    pluginStates: { [manifest.id]: { loading: false, error: null, data: { providerId: manifest.id, displayName: manifest.name, iconUrl: "", lines: names.map((label): MetricLine => ({ type: "progress", label, used: 24, limit: 100, format: { kind: "percent" } })) } } },
    displayMode: "used", preferWeekly,
  })[0]
}

describe("expanded provider primary metrics", () => {
  it("uses the confirmed Antigravity pool without requiring a legacy model label", () => {
    expect(bar(antigravity, ["Gemini", "Gemini Weekly", "Claude"]).label).toBe("Gemini")
    expect(bar(antigravity, ["Gemini", "Gemini Weekly"], true)).toMatchObject({ label: "Gemini Weekly", weekly: true, fraction: 0.24 })
    expect(bar(antigravity, ["Claude Weekly"]).label).toBe("Claude Weekly")
    expect(bar(antigravity, ["Argon Weekly"]).label).toBe("Argon Weekly")
  })

  it("can display OpenRouter account credits when a management key has no per-key budget", () => {
    expect(bar(openrouter, ["Credits"]).label).toBe("Credits")
    expect(bar(openrouter, ["Credits", "Key Limit"]).label).toBe("Key Limit")
  })

  it("uses website credit pools without requiring desktop API credits", () => {
    expect(bar(perplexity, ["Subscription Credits", "Organization Credits"]).label).toBe("Subscription Credits")
    expect(bar(perplexity, ["Organization Credits"]).label).toBe("Organization Credits")
    expect(bar(perplexity, ["API credits"]).label).toBe("API credits")
  })
})
