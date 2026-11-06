import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { MuseLoginPoll, MuseLoginSession } from "@/lib/muse-login"

const mocks = vi.hoisted(() => ({ start: vi.fn(), poll: vi.fn(), cancel: vi.fn(), get: vi.fn(), open: vi.fn() }))
vi.mock("@/lib/muse-login", () => ({ startMuseLogin: mocks.start, pollMuseLogin: mocks.poll, cancelMuseLogin: mocks.cancel }))
vi.mock("@/lib/provider-config", () => ({ getProviderConfig: mocks.get, PROVIDER_CONFIG_CHANGED: "openusage-provider-config-changed" }))
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.open }))
import { MuseConnection } from "@/components/muse-connection"

const time = Date.parse("2026-11-06T12:00:00Z")
const saved = { values: { accessToken: { type: "secret", configured: true, hint: "...demo" }, tokenExpiresAt: { type: "text", value: "2026-11-07T12:00:00Z" } } }
const session: MuseLoginSession = { loginId: "session-one", userCode: "TEST-1234", verificationUri: "https://auth.meta.com/device", expiresAt: time + 60_000, intervalSeconds: 5 }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
async function mount(onSaved = vi.fn().mockResolvedValue(undefined)) {
  const result = render(<MuseConnection onBack={vi.fn()} onSaved={onSaved} />)
  await act(async () => {})
  return { ...result, onSaved }
}
async function start() { await act(async () => { fireEvent.click(screen.getByRole("button", { name: /连接 Meta 账号/ })) }) }
async function tick(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(time)
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.get.mockResolvedValue({ values: {} }); mocks.start.mockResolvedValue(session)
  mocks.poll.mockResolvedValue({ state: "pending" }); mocks.cancel.mockResolvedValue(undefined); mocks.open.mockResolvedValue(undefined)
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

describe("Muse Device Connection", () => {
  it("does not expose manual tokens and distinguishes stored from verified access", async () => {
    mocks.get.mockResolvedValue(saved)
    const { onSaved } = await mount()
    expect(screen.getByText("已保存 Meta 连接")).toBeVisible()
    expect(screen.queryByText("Meta 连接已验证")).not.toBeInTheDocument()
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue(/dca:/)).not.toBeInTheDocument()
    expect(mocks.start).not.toHaveBeenCalled(); expect(onSaved).not.toHaveBeenCalled()
  })
  it("refreshes committed presence without interrupting another pending authorization or checking quota", async () => {
    const { onSaved } = await mount(); await start()
    mocks.get.mockResolvedValue(saved)
    await act(async () => window.dispatchEvent(new CustomEvent("openusage-provider-config-changed", { detail: { providerId: "muse", clearData: true, preserveLoading: true } })))
    expect(screen.getByText("TEST-1234")).toBeVisible()
    expect(screen.getByRole("button", { name: "取消连接" })).toBeVisible()
    expect(onSaved).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "取消连接" })))
    expect(screen.getByText("已保存 Meta 连接")).toBeVisible()
  })
  it.each(["resolve", "reject"])("ignores an older presence read that finishes after the current read: %s", async (outcome) => {
    await mount()
    const old = deferred<any>()
    mocks.get.mockReturnValueOnce(old.promise).mockResolvedValueOnce(saved)
    const changed = () => window.dispatchEvent(new CustomEvent("openusage-provider-config-changed", { detail: { providerId: "muse", clearData: false, preserveLoading: false } }))
    await act(async () => { changed(); changed(); await Promise.resolve() })
    if (outcome === "resolve") await act(async () => old.resolve({ values: { ...saved.values, tokenExpiresAt: { type: "text", value: "2026-11-05T12:00:00Z" } } }))
    else await act(async () => old.reject(new Error("Obsolete Read Failed")))
    expect(screen.getByText("已保存 Meta 连接")).toBeVisible()
    expect(screen.queryByText("已保存的 Meta 连接已过期")).not.toBeInTheDocument()
    expect(screen.queryByText("无法更新连接状态，请重新读取连接。")).not.toBeInTheDocument()
  })
  it("keeps saved but expired credentials and offers explicit reconnect", async () => {
    mocks.get.mockResolvedValue({ values: { ...saved.values, tokenExpiresAt: { type: "text", value: "2026-11-05T12:00:00Z" } } })
    await mount()
    expect(screen.getByText("已保存的 Meta 连接已过期")).toBeVisible()
    expect(screen.queryByRole("button", { name: "检查已保存的连接" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "重新连接 Meta 账号" })).toBeEnabled()
  })
  it("shows only the public code and opens the URI returned by native validation", async () => {
    await mount(); await start()
    expect(screen.getByText("TEST-1234")).toBeVisible()
    expect(screen.queryByText("session-one")).not.toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "打开 Meta 授权网页" })) })
    expect(mocks.open).toHaveBeenCalledWith(session.verificationUri)
    await tick(4999); expect(mocks.poll).not.toHaveBeenCalled()
  })
  it("keeps the changing countdown outside the live authorization status", async () => {
    await mount(); await start()
    const status = screen.getByRole("status")
    const timer = screen.getByRole("timer", { name: "验证码剩余有效时间" })
    expect(status).toHaveTextContent(/^等待授权$/)
    expect(timer).toHaveTextContent("1 分 0 秒")
    expect(timer).toHaveAttribute("aria-live", "off")
    expect(timer.closest('[role="status"]')).toBeNull()
    await tick(1000)
    expect(timer).toHaveTextContent("0 分 59 秒")
    expect(status).toHaveTextContent(/^等待授权$/)
  })
  it("honors slowDown before accepting the saved identity and checking quota once", async () => {
    mocks.poll.mockResolvedValueOnce({ state: "slowDown", intervalSeconds: 10 }).mockResolvedValueOnce({ state: "succeeded" })
    const { onSaved } = await mount(); await start()
    await tick(5000); expect(mocks.poll).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/Meta 正在处理授权/)).toBeVisible()
    await tick(9999); expect(mocks.poll).toHaveBeenCalledTimes(1)
    mocks.get.mockResolvedValue(saved)
    await tick(1)
    expect(onSaved).toHaveBeenCalledExactlyOnceWith("muse")
    expect(screen.getByText("Meta 连接已验证")).toBeVisible()
    await tick(10_000); expect(mocks.poll).toHaveBeenCalledTimes(2)
  })
  it("cancels an in-flight poll and ignores late success without refreshing quota", async () => {
    const pending = deferred<MuseLoginPoll>(); mocks.poll.mockReturnValueOnce(pending.promise)
    const { onSaved } = await mount(); await start(); await tick(5000)
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "取消连接" })) })
    expect(mocks.cancel).toHaveBeenCalledWith("session-one")
    await act(async () => { pending.resolve({ state: "succeeded" }) })
    expect(onSaved).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "连接 Meta 账号" })).toBeVisible()
    await tick(15_000); expect(mocks.poll).toHaveBeenCalledTimes(1)
  })
  it("unmounts without publishing an in-flight authorization result", async () => {
    const pending = deferred<MuseLoginPoll>(); mocks.poll.mockReturnValueOnce(pending.promise)
    const { unmount, onSaved } = await mount(); await start(); await tick(5000)
    unmount()
    expect(mocks.cancel).toHaveBeenCalledWith("session-one")
    await act(async () => { pending.resolve({ state: "succeeded" }) })
    expect(onSaved).not.toHaveBeenCalled(); expect(mocks.get).toHaveBeenCalledTimes(1)
  })
  it("disposes a late start response after cancel without replacing the next session", async () => {
    const pending = deferred<MuseLoginSession>(); mocks.start.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ ...session, loginId: "session-two", userCode: "TEST-5678" })
    await mount()
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "连接 Meta 账号" })) })
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "取消连接" })) })
    await start()
    await act(async () => { pending.resolve(session) })
    expect(screen.getByText("TEST-5678")).toBeVisible()
    expect(screen.queryByText("TEST-1234")).not.toBeInTheDocument()
    expect(mocks.cancel).toHaveBeenCalledWith("session-one")
  })
  it("expires locally at the session deadline and stops polling", async () => {
    mocks.start.mockResolvedValue({ ...session, expiresAt: time + 1000 })
    await mount(); await start(); await tick(1000)
    expect(screen.getByRole("alert")).toHaveTextContent("验证码已过期")
    expect(mocks.cancel).toHaveBeenCalledWith("session-one")
    expect(mocks.poll).not.toHaveBeenCalled()
    await tick(20_000); expect(mocks.poll).not.toHaveBeenCalled()
  })
  it("retains the newly saved connection when the separate quota check fails", async () => {
    mocks.poll.mockResolvedValue({ state: "succeeded" })
    const onSaved = vi.fn().mockRejectedValue(new Error("quota failed"))
    await mount(onSaved); await start(); await tick(5000)
    expect(screen.getByText("已保存 Meta 连接")).toBeVisible()
    expect(screen.getByRole("alert")).toHaveTextContent("连接已保存，用量检查未完成")
    mocks.get.mockResolvedValue(saved); onSaved.mockResolvedValue(undefined)
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "检查已保存的连接" })) })
    expect(screen.getByText("Meta 连接已验证")).toBeVisible()
    expect(mocks.start).toHaveBeenCalledTimes(1)
  })
  it("does not expose unexpected errors containing credentials", async () => {
    mocks.start.mockRejectedValue("unexpected dca:private-access-token email@example.com")
    await mount(); await start()
    expect(screen.getByRole("alert")).toHaveTextContent("连接暂不可用")
    expect(document.body.textContent).not.toContain("private-access-token")
    expect(console.error).toHaveBeenCalledWith("Failed to start Muse authorization")
  })
  it("recovers a failed masked config read before allowing new authorization", async () => {
    mocks.get.mockRejectedValueOnce("read denied").mockResolvedValueOnce(saved)
    await mount()
    expect(screen.getByRole("button", { name: "重新读取连接" })).toBeVisible()
    expect(screen.queryByRole("button", { name: /连接 Meta 账号/ })).not.toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "重新读取连接" })) })
    expect(screen.getByText("已保存 Meta 连接")).toBeVisible()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})
