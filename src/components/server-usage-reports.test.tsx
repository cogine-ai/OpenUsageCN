import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }))
import { ServerUsageReports } from "./server-usage-reports"

describe("Server Reports", () => {
  beforeEach(() => { tauri.invoke.mockReset() })

  it("preserves readable tokens and negative credits with missing-day and permission states", async () => {
    tauri.invoke.mockImplementation((command, args) => Promise.resolve(command === "refresh_provider_reports" ? {
      ...args, scopeKey: "a".repeat(64), fetchedAt: "2026-11-04T00:00:00Z",
      lines: [{ type: "text", label: "Charged Credits", value: "-2.5" }, { type: "text", label: "Reported Tokens", value: "1,000" }],
      reports: [{ id: "counts", label: "Tokens And Turns", status: "partial", coverage: { fromDate: "2026-11-01", toDate: "2026-11-03", timeZone: "UTC", reportedDates: ["2026-11-01", "2026-11-03"], missingDates: ["2026-11-02"] } },
        { id: "models", label: "Model Breakdown", status: "permissionDenied", message: "Current workspace does not allow model details." }],
    } : null))
    render(<ServerUsageReports providerId="codex" />)
    expect(tauri.invoke).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Load Reports" }))
    expect(await screen.findByText("-2.5")).toBeVisible()
    expect(screen.getByText("1,000")).toBeVisible()
    expect(screen.getByText("Access Denied")).toBeVisible()
    expect(screen.getByText(/1 天未报告/)).toBeVisible()
    expect(screen.getByRole("button", { name: "Refresh Reports" })).toBeEnabled()
  })

  it("shows failure and allows retry without inventing zero usage", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    tauri.invoke.mockRejectedValue("private upstream response")
    render(<ServerUsageReports providerId="ollama" />)
    fireEvent.click(screen.getByRole("button", { name: "Load Reports" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("无法读取")
    expect(screen.queryByText("private upstream response")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Load Reports" })).toBeEnabled()
    expect(log).toHaveBeenCalled()
  })
})
