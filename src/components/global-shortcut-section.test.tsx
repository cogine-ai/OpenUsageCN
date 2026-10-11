import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock, isTauri: () => true }))
import { GlobalShortcutSection } from "@/components/global-shortcut-section"

function renderSection(shortcut: string | null = null, onChange = vi.fn().mockResolvedValue(undefined)) {
  render(<GlobalShortcutSection globalShortcut={shortcut} onGlobalShortcutChange={onChange} />)
  return onChange
}
async function recording() {
  await userEvent.click(screen.getByRole("button", { name: /设置快捷键|编辑快捷键/ }))
  return screen.getByRole("textbox", { name: "按下要设置的快捷键" })
}
function chord(textbox: HTMLElement, codes: string[]) {
  const held = new Set<string>()
  const flags = () => ({
    metaKey: [...held].some((code) => code.startsWith("Meta")),
    ctrlKey: [...held].some((code) => code.startsWith("Control")),
    altKey: [...held].some((code) => code.startsWith("Alt")),
    shiftKey: [...held].some((code) => code.startsWith("Shift")),
  })
  for (const code of codes) { held.add(code); fireEvent.keyDown(textbox, { code, ...flags() }) }
  for (const code of [...codes].reverse()) { held.delete(code); fireEvent.keyUp(textbox, { code, ...flags() }) }
}

describe("GlobalShortcutSection", () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockResolvedValue({ shortcut: null, active: false, error: null })
  })
  it("renders physical modifier keycaps and does not repeat setup instructions", async () => {
    invokeMock.mockResolvedValue({ shortcut: "CommandOrControl+Control+Alt+Shift+U", active: true, error: null })
    renderSection("CommandOrControl+Control+Alt+Shift+U")
    for (const key of ["⌘", "⌃", "⌥", "⇧", "U"]) expect(await screen.findByText(key)).toBeInTheDocument()
    expect(screen.queryByText(/Escape|点击设置|随时打开/)).not.toBeInTheDocument()
  })
  it("records Command and Control as different shortcuts", async () => {
    const changed = renderSection()
    chord(await recording(), ["MetaLeft", "ControlLeft", "ShiftLeft", "KeyU"])
    await waitFor(() => expect(changed).toHaveBeenCalledWith("Command+Control+Shift+U"))
  })
  it.each([
    ["KeyU", { metaKey: true, ctrlKey: true }, "Command+Control+U"],
    ["F11", { metaKey: true, altKey: true, shiftKey: true }, "Command+Alt+Shift+F11"],
  ] as const)("records %s when only the main event carries modifier flags", async (code, modifiers, expected) => {
    const changed = renderSection()
    const textbox = await recording()
    fireEvent.keyDown(textbox, { code, ...modifiers })
    expect(changed).not.toHaveBeenCalled()
    fireEvent.keyUp(textbox, { code })
    await waitFor(() => expect(changed).toHaveBeenCalledExactlyOnceWith(expected))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
  it("waits until flag-discovered modifiers are released before applying", async () => {
    const changed = renderSection()
    const textbox = await recording()
    fireEvent.keyDown(textbox, { code: "KeyU", metaKey: true, altKey: true })
    fireEvent.keyUp(textbox, { code: "KeyU", metaKey: true, altKey: true })
    expect(changed).not.toHaveBeenCalled()
    fireEvent.keyUp(textbox, { code: "AltLeft", metaKey: true })
    expect(changed).not.toHaveBeenCalled()
    fireEvent.keyUp(textbox, { code: "MetaLeft" })
    await waitFor(() => expect(changed).toHaveBeenCalledExactlyOnceWith("Command+Alt+U"))
  })
  it("finishes a Command combination when WebKit omits the main keyup", async () => {
    const changed = renderSection()
    const textbox = await recording()
    fireEvent.keyDown(textbox, { code: "KeyU", metaKey: true })
    fireEvent.keyUp(textbox, { code: "MetaLeft" })
    expect(changed).toHaveBeenCalledExactlyOnceWith("Command+U")
  })
  it("waits for the last other modifier after Command releases with no main keyup", async () => {
    const changed = renderSection()
    const textbox = await recording()
    fireEvent.keyDown(textbox, { code: "F11", metaKey: true, altKey: true, shiftKey: true })
    fireEvent.keyUp(textbox, { code: "MetaLeft", altKey: true, shiftKey: true })
    expect(changed).not.toHaveBeenCalled()
    fireEvent.keyUp(textbox, { code: "ShiftLeft", altKey: true })
    expect(changed).not.toHaveBeenCalled()
    fireEvent.keyUp(textbox, { code: "AltLeft" })
    expect(changed).toHaveBeenCalledExactlyOnceWith("Command+Alt+Shift+F11")
  })
  it("keeps a captured candidate when a later event contains only modifiers", async () => {
    const changed = renderSection()
    const textbox = await recording()
    fireEvent.keyDown(textbox, { code: "KeyU", metaKey: true })
    fireEvent.keyUp(textbox, { code: "KeyU", metaKey: true })
    fireEvent.keyDown(textbox, { code: "ControlLeft", metaKey: true, ctrlKey: true })
    fireEvent.keyUp(textbox, { code: "ControlLeft", metaKey: true })
    fireEvent.keyUp(textbox, { code: "MetaLeft" })
    expect(changed).toHaveBeenCalledExactlyOnceWith("Command+U")
  })
  it("rejects multiple main keys with missing keyup and resets Command state for the next chord", async () => {
    const changed = renderSection()
    const textbox = await recording()
    fireEvent.keyDown(textbox, { code: "KeyA", metaKey: true })
    fireEvent.keyDown(textbox, { code: "KeyB", metaKey: true })
    fireEvent.keyUp(textbox, { code: "MetaLeft" })
    expect(changed).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent("修饰键")
    fireEvent.keyDown(textbox, { code: "KeyK", altKey: true })
    fireEvent.keyUp(textbox, { code: "AltLeft" })
    expect(changed).not.toHaveBeenCalled()
    fireEvent.keyUp(textbox, { code: "KeyK" })
    expect(changed).toHaveBeenCalledExactlyOnceWith("Alt+K")
  })
  it("resets Command state after canceling and waits for normal main keyup in a new recording", async () => {
    const changed = renderSection()
    const previous = await recording()
    fireEvent.keyDown(previous, { code: "KeyU", metaKey: true })
    fireEvent.keyDown(previous, { code: "Escape" })
    const textbox = await recording()
    fireEvent.keyDown(textbox, { code: "KeyK", altKey: true })
    fireEvent.keyUp(textbox, { code: "AltLeft" })
    expect(changed).not.toHaveBeenCalled()
    fireEvent.keyUp(textbox, { code: "KeyK" })
    expect(changed).toHaveBeenCalledExactlyOnceWith("Alt+K")
  })
  it("rejects multiple main keys even when modifiers arrive only as flags", async () => {
    const changed = renderSection()
    const textbox = await recording()
    fireEvent.keyDown(textbox, { code: "KeyA", metaKey: true })
    fireEvent.keyDown(textbox, { code: "KeyB", metaKey: true })
    fireEvent.keyUp(textbox, { code: "KeyB", metaKey: true })
    fireEvent.keyUp(textbox, { code: "KeyA" })
    expect(changed).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent("修饰键")
  })
  it("suspends the old native shortcut while recording a flag-only chord and restores it after applying", async () => {
    invokeMock.mockResolvedValue({ shortcut: "Command+U", active: true, error: null })
    const changed = renderSection("Command+U")
    const textbox = await recording()
    expect(invokeMock).toHaveBeenCalledWith("set_global_shortcut_recording", { recording: true })
    fireEvent.keyDown(textbox, { code: "KeyU", metaKey: true })
    expect(changed).not.toHaveBeenCalled()
    fireEvent.keyUp(textbox, { code: "KeyU" })
    await waitFor(() => expect(changed).toHaveBeenCalledExactlyOnceWith("Command+U"))
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("set_global_shortcut_recording", { recording: false }))
  })
  it("maps Enter, arrow and Numpad keys without changing modifier meaning", async () => {
    const changed = renderSection()
    chord(await recording(), ["ControlLeft", "Enter"])
    await waitFor(() => expect(changed).toHaveBeenCalledWith("Control+Return"))
    chord(await recording(), ["AltLeft", "ArrowUp"])
    await waitFor(() => expect(changed).toHaveBeenCalledWith("Alt+Up"))
    chord(await recording(), ["MetaLeft", "Numpad1"])
    await waitFor(() => expect(changed).toHaveBeenCalledWith("Command+Numpad1"))
  })
  it("Escape cancels recording and preserves an existing shortcut", async () => {
    invokeMock.mockResolvedValue({ shortcut: "Command+U", active: true, error: null })
    const changed = renderSection("Command+U")
    const textbox = await recording()
    fireEvent.keyDown(textbox, { code: "Escape" })
    expect(changed).not.toHaveBeenCalled()
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    expect(screen.getByText("U")).toBeInTheDocument()
  })
  it("blur and the cancel action preserve the existing shortcut", async () => {
    const changed = renderSection()
    const textbox = await recording()
    fireEvent.keyDown(textbox, { code: "MetaLeft" })
    fireEvent.blur(textbox)
    expect(changed).not.toHaveBeenCalled()
    await recording()
    await userEvent.click(screen.getByRole("button", { name: "取消录制" }))
    expect(changed).not.toHaveBeenCalled()
  })
  it("does not save modifier-only or multiple-main-key chords", async () => {
    const changed = renderSection()
    const textbox = await recording()
    chord(textbox, ["MetaLeft"])
    expect(changed).not.toHaveBeenCalled()
    chord(textbox, ["MetaLeft", "KeyA", "KeyB"])
    expect(changed).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent("修饰键")
  })
  it("waits for application to finish and prevents duplicate operations", async () => {
    let resolve!: () => void
    const changed = vi.fn(() => new Promise<void>((done) => { resolve = done }))
    renderSection(null, changed)
    chord(await recording(), ["MetaLeft", "KeyU"])
    expect(screen.getByLabelText("正在应用快捷键")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "设置快捷键" })).toBeDisabled()
    expect(screen.queryByText("U")).not.toBeInTheDocument()
    await act(async () => resolve())
    expect(screen.getByText("U")).toBeInTheDocument()
  })
  it("retains old keycaps and exposes a registration failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    invokeMock.mockResolvedValue({ shortcut: "Command+U", active: true, error: null })
    const changed = renderSection("Command+U", vi.fn().mockRejectedValue("此组合无法使用，请试另一个快捷键。"))
    chord(await recording(), ["ControlLeft", "KeyK"])
    expect(await screen.findByRole("alert")).toHaveTextContent("此组合无法使用")
    expect(changed).toHaveBeenCalledWith("Control+K")
    expect(screen.getByText("U")).toBeInTheDocument()
    expect(screen.queryByText("K")).not.toBeInTheDocument()
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
  it("shows an initial registration failure as inactive rather than working", async () => {
    invokeMock.mockResolvedValue({ shortcut: "Command+U", active: false, error: "快捷键未生效，请重新设置。" })
    renderSection("Command+U")
    expect(await screen.findByText("未生效")).toBeInTheDocument()
    expect(screen.getByRole("alert")).toHaveTextContent("快捷键未生效")
  })
  it("does not let a late startup status overwrite a successful change", async () => {
    let resolveStatus!: (value: { shortcut: string | null; active: boolean; error: null }) => void
    invokeMock.mockImplementationOnce(() => new Promise((resolve) => { resolveStatus = resolve }))
    renderSection()
    chord(await recording(), ["MetaLeft", "KeyU"])
    await waitFor(() => expect(screen.getByText("U")).toBeInTheDocument())
    await act(async () => resolveStatus({ shortcut: null, active: false, error: null }))
    expect(screen.getByText("U")).toBeInTheDocument()
  })
  it("only clears through the dedicated clear action", async () => {
    invokeMock.mockResolvedValue({ shortcut: "Command+U", active: true, error: null })
    const changed = renderSection("Command+U")
    await userEvent.click(screen.getByRole("button", { name: "清除快捷键" }))
    await waitFor(() => expect(changed).toHaveBeenCalledWith(null))
    expect(screen.getByRole("button", { name: "设置快捷键" })).toBeInTheDocument()
  })
})
