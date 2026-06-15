import { invoke } from "@tauri-apps/api/core"

export type ProviderConfigViewValue =
  | { type: "secret"; configured: boolean; hint?: string | null }
  | { type: "text"; value?: string | null }
  | { type: "select"; value: string }
  | { type: "toggle"; value: boolean }

export type ProviderConfigView = {
  values: Record<string, ProviderConfigViewValue>
}

export type ProviderConfigInput = Record<string, string | boolean>

export function getProviderConfig(pluginId: string): Promise<ProviderConfigView> {
  return invoke<ProviderConfigView>("get_provider_config", { pluginId })
}

export function saveProviderConfig(
  pluginId: string,
  values: ProviderConfigInput
): Promise<void> {
  return invoke("save_provider_config", { pluginId, values })
}

export function deleteProviderConfigField(
  pluginId: string,
  fieldId: string
): Promise<void> {
  return invoke("delete_provider_config_field", { pluginId, fieldId })
}
