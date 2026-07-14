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

import { CliSection } from "@/components/cli-section"

const notInstalled = {
  available: true,
  state: "notInstalled",
  destination: "/usr/local/bin/openusage",
  message: null,
}

describe("CliSection", () => {
  beforeEach(() => {
    invokeMock.mockReset()
    isTauriMock.mockReset()
    isTauriMock.mockReturnValue(true)
    invokeMock.mockResolvedValue(notInstalled)
  })

  it("installs the command and reflects the returned status", async () => {
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(command === "set_cli_installed"
        ? { ...notInstalled, state: "installed" }
        : notInstalled)
    )
    render(<CliSection />)

    await userEvent.click(await screen.findByRole("button", { name: "安装命令" }))

    expect(invokeMock).toHaveBeenCalledWith("set_cli_installed", { installed: true })
    expect(await screen.findByRole("button", { name: "移除命令" })).toBeInTheDocument()
  })

  it("does not overwrite a conflicting command", async () => {
    invokeMock.mockResolvedValue({
      ...notInstalled,
      state: "conflict",
      message: "/usr/local/bin/openusage 已存在且不是由 OpenUsageCN 安装。",
    })
    render(<CliSection />)

    const button = await screen.findByRole("button", { name: "安装命令" })
    expect(button).toBeDisabled()
    expect(screen.getByText(/不是由 OpenUsageCN 安装/)).toBeInTheDocument()
  })

  it("shows a friendly error and refreshes after an install failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    invokeMock
      .mockResolvedValueOnce(notInstalled)
      .mockRejectedValueOnce("管理员授权失败。")
      .mockResolvedValueOnce(notInstalled)
    render(<CliSection />)

    await userEvent.click(await screen.findByRole("button", { name: "安装命令" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("管理员授权失败。")
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledTimes(3)
    })
    errorSpy.mockRestore()
  })
})
