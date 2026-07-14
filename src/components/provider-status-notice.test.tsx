import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { openUrl } from "@tauri-apps/plugin-opener"
import { ProviderStatusNotice } from "@/components/provider-status-notice"

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
}))

describe("ProviderStatusNotice", () => {
  beforeEach(() => {
    vi.mocked(openUrl).mockClear()
  })

  it("stays hidden while the provider is operational", () => {
    render(
      <ProviderStatusNotice
        status={{ level: "operational", description: "All Systems Operational", updatedAt: null }}
        statusUrl="https://status.example.com/"
      />
    )

    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("shows a friendly degraded warning and opens the status page", async () => {
    render(
      <ProviderStatusNotice
        status={{ level: "degraded", description: "Minor Service Outage", updatedAt: null }}
        statusUrl="https://status.example.com/"
      />
    )

    expect(screen.getByText("服务商服务异常")).toBeInTheDocument()
    expect(screen.getByText("服务商当前部分功能异常，数据刷新可能受影响。")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "查看服务状态" }))
    expect(openUrl).toHaveBeenCalledWith("https://status.example.com/")
  })

  it("uses the stronger outage message", () => {
    render(
      <ProviderStatusNotice
        status={{ level: "outage", description: "Major Service Outage", updatedAt: null }}
        statusUrl="https://status.example.com/"
      />
    )

    expect(screen.getByText("服务商服务中断")).toBeInTheDocument()
    expect(screen.getByText("服务商当前发生服务中断，数据刷新可能失败。")).toBeInTheDocument()
  })
})
