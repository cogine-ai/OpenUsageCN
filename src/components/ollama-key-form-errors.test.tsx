import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, expect, it, vi } from "vitest"

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }))
import { OllamaKeyForm } from "./ollama-key-form"

beforeEach(() => {
  tauri.invoke.mockReset()
})

it.each([
  "请填写有效的 Ollama API Key。",
  "此账号没有读取权限，请检查账号权限。",
])("shows the owned verification command's friendly message: %s", async (message) => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {})
  tauri.invoke.mockRejectedValue(message)
  const onSave = vi.fn()
  render(<OllamaKeyForm busy={false} onSave={onSave} onRename={vi.fn()} />)
  await userEvent.type(screen.getByLabelText("名称", { exact: true }), "Personal")
  await userEvent.type(screen.getByLabelText("API Key", { exact: true }), "synthetic-key")
  await userEvent.click(screen.getByRole("button", { name: "验证 Key", exact: true }))
  expect(await screen.findByRole("alert")).toHaveTextContent(message)
  expect(screen.getByRole("button", { name: "验证 Key", exact: true })).toBeEnabled()
  expect(onSave).not.toHaveBeenCalled()
  expect(log).toHaveBeenCalledExactlyOnceWith("Failed to verify Ollama API key")
})

it.each([new Error("unsafe synthetic-key response"), {}, ""])(
  "masks unexpected verification failures without logging raw values: %j",
  async (reason) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    tauri.invoke.mockRejectedValue(reason)
    render(<OllamaKeyForm busy={false} onSave={vi.fn()} onRename={vi.fn()} />)
    await userEvent.type(screen.getByLabelText("名称", { exact: true }), "Personal")
    await userEvent.type(screen.getByLabelText("API Key", { exact: true }), "synthetic-key")
    await userEvent.click(screen.getByRole("button", { name: "验证 Key", exact: true }))
    expect(await screen.findByRole("alert")).toHaveTextContent("原有连接保持不变")
    expect(screen.queryByText(/unsafe/)).not.toBeInTheDocument()
    await waitFor(() => expect(log).toHaveBeenCalledExactlyOnceWith("Failed to verify Ollama API key"))
  }
)
