import { invoke } from "@tauri-apps/api/core"

export type MuseLoginSession = {
  loginId: string
  userCode: string
  verificationUri: string
  expiresAt: number
  intervalSeconds: number
}

export type MuseLoginPoll = {
  state: "pending" | "slowDown" | "succeeded"
  intervalSeconds?: number
}

/** Starts the app-owned Meta device flow without returning credential material. */
export function startMuseLogin(): Promise<MuseLoginSession> {
  return invoke("start_muse_login")
}

/** Polls one session; native code validates identity and conditionally saves its token. */
export function pollMuseLogin(loginId: string): Promise<MuseLoginPoll> {
  return invoke("poll_muse_login", { loginId })
}

/** Cancels only the matching pending authorization, preserving any saved connection. */
export function cancelMuseLogin(loginId: string): Promise<void> {
  return invoke("cancel_muse_login", { loginId })
}
