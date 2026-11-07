import { describe, expect, it } from "vitest"
import { probeFailure } from "@/lib/probe-failure"
import type { PluginOutput } from "@/lib/plugin-types"

function output(overrides: Partial<PluginOutput> & Pick<PluginOutput, "lines">): PluginOutput {
  return {
    providerId: "cursor",
    displayName: "Cursor",
    iconUrl: "",
    ...overrides,
  }
}

describe("probeFailure", () => {
  it("returns the Error badge text for generic probe failures", () => {
    const message = probeFailure(
      output({
        lines: [{ type: "badge", label: "Error", text: "Usage request failed (HTTP 500).", color: "#ef4444" }],
      }),
    )
    expect(message).toBe("Usage request failed (HTTP 500).")
  })

  it("falls back to a friendly message when the Error badge has no text", () => {
    expect(
      probeFailure(output({ lines: [{ type: "badge", label: "Error", text: "", color: "#ef4444" }] })),
    ).toBe("无法更新数据，请重试。")
  })

  it("ignores non-Error badges", () => {
    expect(
      probeFailure(
        output({
          lines: [
            { type: "badge", label: "Status", text: "OK", color: "#22c55e" },
            { type: "progress", label: "Session", used: 1, limit: 100, format: { kind: "percent" } },
          ],
        }),
      ),
    ).toBeNull()
  })

  it("treats Claude rate-limited cached quota as a failure even without an Error badge", () => {
    expect(
      probeFailure(
        output({
          providerId: "claude",
          lines: [
            { type: "badge", label: "Status", text: "Rate limited, retry in ~10m", color: "#f59e0b" },
            { type: "progress", label: "Session", used: 12, limit: 100, format: { kind: "percent" } },
          ],
        }),
      ),
    ).toBe("服务商暂时限制请求；当前数据来自上次读取。请稍后重试。")
  })

  it("does not treat Claude rate limits as failures for other providers", () => {
    expect(
      probeFailure(
        output({
          providerId: "codex",
          lines: [{ type: "badge", label: "Status", text: "Rate limited, try again later", color: "#f59e0b" }],
        }),
      ),
    ).toBeNull()
  })

  it("prefers the Error badge when both Error and Claude rate-limit badges are present", () => {
    expect(
      probeFailure(
        output({
          providerId: "claude",
          lines: [
            { type: "badge", label: "Error", text: "Live usage unavailable.", color: "#ef4444" },
            { type: "badge", label: "Status", text: "Rate limited, try again later", color: "#f59e0b" },
          ],
        }),
      ),
    ).toBe("Live usage unavailable.")
  })
})
