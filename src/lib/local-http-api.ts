import { invoke } from "@tauri-apps/api/core"

export const LOCAL_HTTP_API_BASE_URL = "http://127.0.0.1:6736"

export type LocalHttpApiServiceStatus =
  | { state: "starting"; bind: string }
  | { state: "running"; bind: string; startedAt: string }
  | { state: "bind_failed"; bind: string; error: string; failedAt: string }

export type LocalHttpApiHealth = {
  status: "ok"
  apiVersion: "v1"
  version: string
  service: LocalHttpApiServiceStatus
  providers: {
    known: number
    enabled: number
    cached: number
  }
  cache: {
    ready: boolean
    lastSuccessfulFetchAt: string | null
  }
}

export function getLocalHttpApiStatus(): Promise<LocalHttpApiServiceStatus> {
  return invoke<LocalHttpApiServiceStatus>("get_local_http_api_status")
}

export async function fetchLocalHttpApiHealth(): Promise<LocalHttpApiHealth> {
  const response = await fetch(`${LOCAL_HTTP_API_BASE_URL}/health`, {
    headers: { Accept: "application/json" },
  })
  if (!response.ok) {
    throw new Error(`Local HTTP API health failed (${response.status})`)
  }
  return response.json() as Promise<LocalHttpApiHealth>
}
