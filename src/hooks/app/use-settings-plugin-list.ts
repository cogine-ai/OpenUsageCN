import { useMemo } from "react"
import type { PluginMeta } from "@/lib/plugin-types"
import type { PluginSettings } from "@/lib/settings"

export type SettingsPluginState = {
  id: string
  name: string
  enabled: boolean
  config?: PluginMeta["config"]
  accountSupport?: PluginMeta["accountSupport"]
  links?: PluginMeta["links"]
}

type UseSettingsPluginListArgs = {
  pluginSettings: PluginSettings | null
  pluginsMeta: PluginMeta[]
}

export function useSettingsPluginList({ pluginSettings, pluginsMeta }: UseSettingsPluginListArgs) {
  return useMemo<SettingsPluginState[]>(() => {
    if (!pluginSettings) return []
    const pluginMap = new Map(pluginsMeta.map((plugin) => [plugin.id, plugin]))

    return pluginSettings.order
      .map((id) => {
        const meta = pluginMap.get(id)
        if (!meta) return null
        const plugin: SettingsPluginState = {
          id,
          name: meta.name,
          enabled: !pluginSettings.disabled.includes(id),
        }
        if (meta.config) plugin.config = meta.config
        if (meta.accountSupport) plugin.accountSupport = meta.accountSupport
        if (meta.links) plugin.links = meta.links
        return plugin
      })
      .filter((plugin): plugin is SettingsPluginState => Boolean(plugin))
  }, [pluginSettings, pluginsMeta])
}
