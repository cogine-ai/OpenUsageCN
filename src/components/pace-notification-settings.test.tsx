import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { invokeMock, isTauriMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  isTauriMock: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  isTauri: isTauriMock,
}))

import { PaceNotificationSettingsSection } from "@/components/pace-notification-settings"

describe("PaceNotificationSettingsSection", () => {
  beforeEach(() => {
    invokeMock.mockReset()
    isTauriMock.mockReset()
    isTauriMock.mockReturnValue(true)
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(command === "request_notification_permission" ? "granted" : "default")
    )
  })

  it("requests permission on first enable and reflects the result", async () => {
    const onChange = vi.fn().mockResolvedValue(undefined)
    const { rerender } = render(
      <PaceNotificationSettingsSection
        value={{ almostOut: false, closeToLimit: false, runningOut: false }}
        onChange={onChange}
      />
    )

    await userEvent.click(screen.getByRole("checkbox", { name: "接近上限" }))

    expect(onChange).toHaveBeenCalledWith({
      almostOut: false,
      closeToLimit: true,
      runningOut: false,
    })
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("request_notification_permission")
    })
    rerender(
      <PaceNotificationSettingsSection
        value={{ almostOut: false, closeToLimit: true, runningOut: false }}
        onChange={onChange}
      />
    )
    expect(screen.queryByLabelText("系统通知权限未开启")).not.toBeInTheDocument()
  })

  it("does not request permission when another alert is already enabled", async () => {
    render(
      <PaceNotificationSettingsSection
        value={{ almostOut: true, closeToLimit: false, runningOut: false }}
        onChange={vi.fn().mockResolvedValue(undefined)}
      />
    )

    await userEvent.click(screen.getByRole("checkbox", { name: "接近上限" }))
    expect(invokeMock).not.toHaveBeenCalledWith("request_notification_permission")
  })

  it("shows a friendly error when permission cannot be requested", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    invokeMock.mockImplementation((command: string) =>
      command === "request_notification_permission"
        ? Promise.reject(new Error("native failure"))
        : Promise.resolve("default")
    )
    render(
      <PaceNotificationSettingsSection
        value={{ almostOut: false, closeToLimit: false, runningOut: false }}
        onChange={vi.fn().mockResolvedValue(undefined)}
      />
    )

    await userEvent.click(screen.getByRole("checkbox", { name: "接近上限" }))
    expect(await screen.findByText("无法请求系统通知权限。")).toBeInTheDocument()
    errorSpy.mockRestore()
  })

  it("shows a friendly error when notification settings cannot be saved", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    render(
      <PaceNotificationSettingsSection
        value={{ almostOut: false, closeToLimit: false, runningOut: false }}
        onChange={vi.fn().mockRejectedValue(new Error("store failure"))}
      />
    )

    await userEvent.click(screen.getByRole("checkbox", { name: "接近上限" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("无法保存额度通知设置。")
    expect(invokeMock).not.toHaveBeenCalledWith("request_notification_permission")
    errorSpy.mockRestore()
  })
})
