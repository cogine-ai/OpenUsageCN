import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }))
import { OllamaAccountsPage } from "./ollama-accounts"

afterEach(() => {
  vi.useRealTimers()
})

it("updates the viewed account's reset countdown without refreshing its quota", async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-11-05T00:00:00Z"))
  vi.spyOn(document, "hidden", "get").mockReturnValue(false)
  tauri.listen.mockResolvedValue(vi.fn())
  tauri.invoke.mockResolvedValue({
    revision: 1,
    legacy: { source: "cookie", configured: false, revision: 0 },
    primary: { mode: "connection", connectionId: "home" },
    connections: [
      {
        connectionId: "home",
        label: "个人账号",
        identity: { name: "@home" },
        keyHint: "8F2A",
        revision: 1,
        snapshot: {
          providerId: "ollama",
          displayName: "Ollama Cloud",
          iconUrl: "",
          lines: [
            {
              type: "progress",
              label: "Monthly",
              used: 24,
              limit: 100,
              format: { kind: "dollars" },
              resetsAt: "2026-11-05T00:06:00Z",
            },
          ],
        },
      },
    ],
  })
  await act(async () => {
    render(<OllamaAccountsPage />)
  })
  fireEvent.click(screen.getByRole("button", { name: "查看个人账号用量" }))
  expect(screen.getByText("6 分钟后重置", { exact: true })).toBeInTheDocument()

  act(() => vi.advanceTimersByTime(30_000))
  expect(screen.getByText("5 分钟后重置", { exact: true })).toBeInTheDocument()
  act(() => vi.advanceTimersByTime(60_000))
  expect(screen.getByText("即将重置", { exact: true })).toBeInTheDocument()
  expect(tauri.invoke).toHaveBeenCalledExactlyOnceWith("get_ollama_accounts")
})
