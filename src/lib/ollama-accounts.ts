import { invoke } from "@tauri-apps/api/core"
import type { PluginOutput } from "@/lib/plugin-types"

export const OLLAMA_ACCOUNTS_CHANGED = "ollama-accounts-changed"

export type OllamaIdentity = { name?: string; email?: string }
export type OllamaPrimary = { mode: "legacy" | "none" | "connection"; connectionId?: string }
export type OllamaConnection = {
  connectionId: string
  label: string
  identity: OllamaIdentity
  keyHint: string
  plan?: string
  snapshot?: PluginOutput
  lastUpdatedAt?: string
  error?: { code: string; message: string }
  revision: number
}
export type OllamaAccountsView = {
  revision: number
  primary: OllamaPrimary
  connections: OllamaConnection[]
  legacy: OllamaLegacyConnection
}
export type OllamaLegacyConnection = {
  source: "cookie" | "apiKey"
  configured: boolean
  revision: number
  snapshot?: PluginOutput
  lastUpdatedAt?: string
  error?: { code: string; message: string }
}
export type OllamaAccountSelection = { kind: "legacy" } | { kind: "connection"; connectionId: string }
export type OllamaVerification = {
  verificationId: string
  identity: OllamaIdentity
  keyHint: string
  plan?: string
  differentAccount: boolean
  sameAccount?: boolean
}
export type OllamaAccountOperation = {
  kind: "selectPrimary" | "useLegacy" | "rename" | "remove" | "refresh" | "refreshLegacy"
  connectionId?: string
  label?: string
}

export function getOllamaAccounts() {
  return invoke<OllamaAccountsView>("get_ollama_accounts")
}

export function checkOllamaLegacyConnection() {
  return invoke<PluginOutput>("check_ollama_legacy_connection")
}

export function verifyOllamaKey(apiKey: string, connectionId?: string) {
  return invoke<OllamaVerification>("verify_ollama_key", {
    apiKey,
    ...(connectionId ? { connectionId } : {}),
  })
}

export function saveOllamaKey(verificationId: string, label: string, asNew = false) {
  return invoke<OllamaAccountsView>("save_ollama_key", { verificationId, label, asNew })
}

export function performOllamaAccountOperation(operation: OllamaAccountOperation) {
  return invoke<OllamaAccountsView>("perform_ollama_account_operation", { operation })
}

export function ollamaIdentityLabel(identity: OllamaIdentity) {
  return identity.name || identity.email || "已验证账号"
}
