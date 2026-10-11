import { describe, expect, it } from "vitest"
import { groupLinesByType } from "@/lib/group-lines-by-type"

describe("groupLinesByType", () => {
  it("returns empty array for empty input", () => {
    expect(groupLinesByType([])).toEqual([])
  })

  it("groups consecutive text lines together", () => {
    const lines = [
      { type: "text" as const, label: "Today", value: "$0.00" },
      { type: "text" as const, label: "Yesterday", value: "$1.00" },
      { type: "text" as const, label: "Last 30 Days", value: "$5.00" },
    ]
    const groups = groupLinesByType(lines)
    expect(groups).toHaveLength(1)
    expect(groups[0].kind).toBe("text")
    expect(groups[0].lines).toHaveLength(3)
  })

  it("keeps non-text lines as separate 'other' entries", () => {
    const lines = [
      { type: "progress" as const, label: "Session", used: 50, limit: 100, format: { kind: "percent" as const } },
      { type: "progress" as const, label: "Weekly", used: 30, limit: 100, format: { kind: "percent" as const } },
    ]
    const groups = groupLinesByType(lines)
    expect(groups).toHaveLength(1)
    expect(groups[0].kind).toBe("other")
    expect(groups[0].lines).toHaveLength(2)
  })

  it("creates separate groups for alternating text and non-text lines", () => {
    const lines = [
      { type: "progress" as const, label: "Session", used: 50, limit: 100, format: { kind: "percent" as const } },
      { type: "text" as const, label: "Today", value: "$0.00" },
      { type: "text" as const, label: "Yesterday", value: "$1.00" },
      { type: "badge" as const, label: "Status", text: "OK" },
    ]
    const groups = groupLinesByType(lines)
    expect(groups).toHaveLength(3)
    expect(groups[0].kind).toBe("other")
    expect(groups[0].lines).toHaveLength(1)
    expect(groups[1].kind).toBe("text")
    expect(groups[1].lines).toHaveLength(2)
    expect(groups[2].kind).toBe("other")
    expect(groups[2].lines).toHaveLength(1)
  })
})
