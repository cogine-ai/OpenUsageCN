import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { GlobalShortcutSection } from "@/components/global-shortcut-section"

function renderSection(globalShortcut: string | null = null) {
  const onGlobalShortcutChange = vi.fn()
  render(
    <GlobalShortcutSection
      globalShortcut={globalShortcut}
      onGlobalShortcutChange={onGlobalShortcutChange}
    />
  )
  return { onGlobalShortcutChange }
}

async function startRecording() {
  await userEvent.click(screen.getByRole("button", { name: /点击设置/ }))
  return screen.getByRole("textbox", { name: /按下要设置的快捷键/ })
}

describe("GlobalShortcutSection", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("formats persisted shortcuts for display", () => {
    renderSection("CommandOrControl+Alt+Delete")
    expect(screen.getByText("Cmd + Opt + Delete")).toBeInTheDocument()
  })

  it("records and saves CommandOrControl + Shift + key", async () => {
    const { onGlobalShortcutChange } = renderSection()
    const textbox = await startRecording()

    fireEvent.keyDown(textbox, { key: "Meta", code: "MetaLeft" })
    fireEvent.keyDown(textbox, { key: "Shift", code: "ShiftLeft" })
    fireEvent.keyDown(textbox, { key: "U", code: "KeyU" })
    expect(screen.getByText("Cmd + Shift + U")).toBeInTheDocument()

    fireEvent.keyUp(textbox, { key: "U", code: "KeyU" })
    fireEvent.keyUp(textbox, { key: "Shift", code: "ShiftLeft" })
    fireEvent.keyUp(textbox, { key: "Meta", code: "MetaLeft" })

    expect(onGlobalShortcutChange).toHaveBeenCalledWith("CommandOrControl+Shift+U")
    expect(screen.queryByRole("textbox", { name: /按下要设置的快捷键/ })).toBeNull()
  })

  it("maps Enter to Return and Numpad keys for display", async () => {
    const { onGlobalShortcutChange } = renderSection()
    const textbox = await startRecording()

    fireEvent.keyDown(textbox, { key: "Meta", code: "MetaLeft" })
    fireEvent.keyDown(textbox, { key: "Enter", code: "Enter" })
    expect(screen.getByText("Cmd + Enter")).toBeInTheDocument()
    fireEvent.keyUp(textbox, { key: "Enter", code: "Enter" })
    fireEvent.keyUp(textbox, { key: "Meta", code: "MetaLeft" })
    expect(onGlobalShortcutChange).toHaveBeenLastCalledWith("CommandOrControl+Return")

    const textbox2 = await startRecording()
    fireEvent.keyDown(textbox2, { key: "Meta", code: "MetaLeft" })
    fireEvent.keyDown(textbox2, { key: "1", code: "Numpad1" })
    expect(screen.getByText("Cmd + Num1")).toBeInTheDocument()
    fireEvent.keyUp(textbox2, { key: "1", code: "Numpad1" })
    fireEvent.keyUp(textbox2, { key: "Meta", code: "MetaLeft" })
    expect(onGlobalShortcutChange).toHaveBeenLastCalledWith("CommandOrControl+Numpad1")
  })

  it("deduplicates Meta + Control into one CommandOrControl modifier", async () => {
    const { onGlobalShortcutChange } = renderSection()
    const textbox = await startRecording()

    fireEvent.keyDown(textbox, { key: "Meta", code: "MetaLeft" })
    fireEvent.keyDown(textbox, { key: "Control", code: "ControlLeft" })
    fireEvent.keyDown(textbox, { key: "A", code: "KeyA" })
    expect(screen.getByText("Cmd + A")).toBeInTheDocument()

    fireEvent.keyUp(textbox, { key: "A", code: "KeyA" })
    fireEvent.keyUp(textbox, { key: "Control", code: "ControlLeft" })
    fireEvent.keyUp(textbox, { key: "Meta", code: "MetaLeft" })

    expect(onGlobalShortcutChange).toHaveBeenCalledWith("CommandOrControl+A")
  })

  it("records and saves Alt shortcuts", async () => {
    const { onGlobalShortcutChange } = renderSection()
    const textbox = await startRecording()

    fireEvent.keyDown(textbox, { key: "Alt", code: "AltLeft" })
    fireEvent.keyDown(textbox, { key: "/", code: "Slash" })
    expect(screen.getByText("Opt + /")).toBeInTheDocument()

    fireEvent.keyUp(textbox, { key: "/", code: "Slash" })
    fireEvent.keyUp(textbox, { key: "Alt", code: "AltLeft" })

    expect(onGlobalShortcutChange).toHaveBeenCalledWith("Alt+Slash")
  })

  it("does not save when only modifiers are pressed", async () => {
    const { onGlobalShortcutChange } = renderSection()
    const textbox = await startRecording()

    fireEvent.keyDown(textbox, { key: "Meta", code: "MetaLeft" })
    fireEvent.keyUp(textbox, { key: "Meta", code: "MetaLeft" })

    expect(onGlobalShortcutChange).not.toHaveBeenCalled()
    expect(screen.getByRole("textbox", { name: /按下要设置的快捷键/ })).toBeInTheDocument()
  })

  it("clears and exits recording on Escape", async () => {
    const { onGlobalShortcutChange } = renderSection("CommandOrControl+Shift+U")
    const trigger = screen.getByRole("button", { name: /Cmd \+ Shift \+ U/i })
    await userEvent.click(trigger)

    const textbox = screen.getByRole("textbox", { name: /按下要设置的快捷键/ })
    fireEvent.keyDown(textbox, { key: "Escape", code: "Escape" })

    expect(onGlobalShortcutChange).toHaveBeenCalledWith(null)
    expect(screen.queryByRole("textbox", { name: /按下要设置的快捷键/ })).toBeNull()
  })

  it("clears existing shortcut from clear button without starting recording", async () => {
    const { onGlobalShortcutChange } = renderSection("CommandOrControl+Shift+U")
    await userEvent.click(screen.getByRole("button", { name: /清除快捷键/ }))

    expect(onGlobalShortcutChange).toHaveBeenCalledWith(null)
    expect(screen.queryByRole("textbox", { name: /按下要设置的快捷键/ })).toBeNull()
  })

  it("starts recording from keyboard activation keys", () => {
    renderSection()
    const trigger = screen.getByRole("button", { name: /点击设置/ })

    fireEvent.keyDown(trigger, { key: "Enter" })
    expect(screen.getByRole("textbox", { name: /按下要设置的快捷键/ })).toBeInTheDocument()

    fireEvent.blur(screen.getByRole("textbox", { name: /按下要设置的快捷键/ }))
    expect(screen.queryByRole("textbox", { name: /按下要设置的快捷键/ })).toBeNull()

    fireEvent.keyDown(trigger, { key: " " })
    expect(screen.getByRole("textbox", { name: /按下要设置的快捷键/ })).toBeInTheDocument()
  })

  it("focuses the recording textbox after starting", async () => {
    vi.useFakeTimers()
    renderSection()

    fireEvent.click(screen.getByRole("button", { name: /点击设置/ }))
    const textbox = screen.getByRole("textbox", { name: /按下要设置的快捷键/ })

    await act(async () => {
      vi.advanceTimersByTime(10)
    })

    expect(textbox).toHaveFocus()
  })

  it("cancels recording on blur without saving pending shortcut", async () => {
    const { onGlobalShortcutChange } = renderSection()
    const textbox = await startRecording()

    fireEvent.keyDown(textbox, { key: "Meta", code: "MetaLeft" })
    fireEvent.keyDown(textbox, { key: "Q", code: "KeyQ" })
    expect(screen.getByText("Cmd + Q")).toBeInTheDocument()

    fireEvent.blur(textbox)
    expect(onGlobalShortcutChange).not.toHaveBeenCalled()
    expect(screen.queryByRole("textbox", { name: /按下要设置的快捷键/ })).toBeNull()
  })
})
