import { describe, expect, it } from "vitest"
import { getPluginRecovery } from "@/lib/plugin-recovery"

describe("New Provider Connection Recovery", () => {
  it.each([
    ["muse", "Connect Muse Code with Meta to view usage.", undefined],
    ["muse", "Muse Code connection is invalid. Connect with Meta again.", undefined],
    ["muse", "Muse Code session expired. Connect with Meta again.", undefined],
    ["claude-platform", "Multiple Claude Platform API organizations are available. Add an Organization ID in Settings.", "organizationId"],
    ["claude-platform", "The configured Claude Platform API organization is unavailable. Check Organization ID in Settings.", "organizationId"],
    ["workbuddy", "Add the Cookie and matching User-Agent from a WorkBuddy usage-page request.", undefined],
    ["workbuddy", "WorkBuddy session expired or its User-Agent does not match. Copy both from the same request.", undefined],
    ["litellm", "LiteLLM Proxy URL is invalid. Use HTTPS, or HTTP on a local or private network, without credentials or a query.", "baseUrl"],
    ["litellm", "Add a LiteLLM virtual API key in Settings.", "apiKey"],
    ["siliconflow", "Choose China or International in SiliconFlow settings.", "region"],
    ["siliconflow", "Add a valid SiliconFlow API key in Settings.", "apiKey"],
  ])("routes %s to its supported configuration flow", (id, message, focus) => {
    const result = getPluginRecovery(message, id)
    expect(result.action).toBe("config")
    expect(result.focusField).toBe(focus)
    if (id === "muse") {
      expect(result.actionLabel).toBe("连接 Meta 账号")
      expect(result.advice).not.toMatch(/粘贴|token|CLI/)
    }
  })
  it("masks a bare Meta DCA credential in diagnostic text", () => {
    expect(getPluginRecovery("raw dca:raw-token-with-private-suffix").diagnostic).not.toContain("raw-token-with-private-suffix")
  })
})
