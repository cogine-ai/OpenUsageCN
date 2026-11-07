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

  it("uses the known counts report calendar rather than a different report's coverage", async () => {
    tauri.invoke.mockImplementation((command, args) => Promise.resolve(command === "refresh_provider_reports" ? {
      ...args, scopeKey: "a".repeat(64), fetchedAt: "2026-11-04T00:00:00Z",
      lines: [{ type: "barChart", label: "Daily Tokens", points: [{ label: "2026-11-01", value: 0 }, { label: "2026-11-03", value: 20 }] },
        { type: "barChart", label: "Unknown Daily Chart", points: [{ label: "2026-11-03", value: 1 }] }],
      reports: [{ id: "credits", label: "Charged Credits", status: "ready", coverage: { fromDate: "2026-11-02", toDate: "2026-11-02", timeZone: "UTC", reportedDates: ["2026-11-02"], missingDates: [] } },
        { id: "counts", label: "Tokens And Turns", status: "partial", coverage: { fromDate: "2026-11-01", toDate: "2026-11-03", timeZone: "UTC", reportedDates: ["2026-11-01", "2026-11-03"], missingDates: ["2026-11-02"] } }],
    } : null))
    render(<ServerUsageReports providerId="codex" />)
    fireEvent.click(screen.getByRole("button", { name: "Load Reports" }))
    expect(await screen.findByRole("button", { name: /Daily Tokens：共 3 天，1 天未报告/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Unknown Daily Chart：共 1 天/ })).toBeInTheDocument()
  })

  it("keeps Ollama's actual inclusive 7D and 30D calendars separate", async () => {
    tauri.invoke.mockImplementation((command, args) => Promise.resolve(command === "refresh_provider_reports" ? {
      ...args, scopeKey: "a".repeat(64), fetchedAt: "2026-02-02T00:00:00Z",
      lines: ["7D", "30D"].map((range) => ({ type: "barChart", label: `${range} Daily Requests (UTC)`, points: [{ label: "2026-02-02", value: 0 }] })),
      reports: [
        { id: "7d", label: "7D Model Usage", status: "partial", coverage: { fromDate: "2026-01-26", toDate: "2026-02-02", timeZone: "UTC", reportedDates: ["2026-02-02"], missingDates: [] } },
        { id: "30d", label: "30D Model Usage", status: "partial", coverage: { fromDate: "2026-01-03", toDate: "2026-02-02", timeZone: "UTC", reportedDates: ["2026-02-02"], missingDates: [] } },
      ],
    } : null))
    render(<ServerUsageReports providerId="ollama" />)
    fireEvent.click(screen.getByRole("button", { name: "Load Reports" }))
    expect(await screen.findByRole("button", { name: /7D Daily Requests \(UTC\)：共 8 天，7 天未报告/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /30D Daily Requests \(UTC\)：共 31 天，30 天未报告/ })).toBeInTheDocument()
  })
})
