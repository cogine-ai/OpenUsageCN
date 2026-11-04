import { invoke } from "@tauri-apps/api/core"

export const PROVIDER_CONFIG_CHANGED = "openusage-provider-config-changed"

export type ProviderConfigViewValue =
  | { type: "secret"; configured: boolean; hint?: string | null }
  | { type: "text"; value?: string | null }
  | { type: "select"; value: string }
  | { type: "toggle"; value: boolean }

export type ProviderConfigView = {
  values: Record<string, ProviderConfigViewValue>
  storedFields?: string[]
  environment?: Record<string, { name: string; configured: boolean; value?: string }>
  environmentError?: string
  environmentUnresolved?: string[]
}

export type ProviderConfigInput = Record<string, string | boolean>

/** Read masked saved values and confirmed sources, retaining separate lookup errors. */
export function getProviderConfig(pluginId: string): Promise<ProviderConfigView> {
  return invoke<ProviderConfigView>("get_provider_config", { pluginId })
}

/** Persist supplied fields only; this does not verify access or enable the provider. */
export async function saveProviderConfig(
  pluginId: string,
  values: ProviderConfigInput
): Promise<void> {
  await invoke("save_provider_config", { pluginId, values })
  window.dispatchEvent(new CustomEvent(PROVIDER_CONFIG_CHANGED, { detail: pluginId }))
}

/** Remove one saved override so the provider can use its remaining sources. */
export async function deleteProviderConfigField(
  pluginId: string,
  fieldId: string
): Promise<void> {
  await invoke("delete_provider_config_field", { pluginId, fieldId })
  window.dispatchEvent(new CustomEvent(PROVIDER_CONFIG_CHANGED, { detail: pluginId }))
}
