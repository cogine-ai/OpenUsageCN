import { describe, expect, it, vi } from "vitest"
const invoke = vi.hoisted(() => vi.fn())
vi.mock("@tauri-apps/api/core", () => ({ invoke }))
import { cancelMuseLogin, pollMuseLogin, startMuseLogin } from "@/lib/muse-login"

describe("Muse Login IPC", () => {
  it("sends only camelCase session selectors and no credential fields", async () => {
    invoke.mockResolvedValue(undefined)
    await startMuseLogin()
    await pollMuseLogin("public-session")
    await cancelMuseLogin("public-session")
    expect(invoke.mock.calls).toEqual([
      ["start_muse_login"],
      ["poll_muse_login", { loginId: "public-session" }],
      ["cancel_muse_login", { loginId: "public-session" }],
    ])
  })
})
