import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { getCurrentWindow, PhysicalSize } from "@tauri-apps/api/window"
import { PanelHeader, type Tab } from "@/components/panel-header"
import { PanelFooter } from "@/components/panel-footer"
import { OverviewPage } from "@/pages/overview"
import { SettingsPage } from "@/pages/settings"
import type { PluginMeta, PluginOutput } from "@/lib/plugin-types"
import { useProbeEvents } from "@/hooks/use-probe-events"
import {
  arePluginSettingsEqual,
  getEnabledPluginIds,
  loadPluginSettings,
  normalizePluginSettings,
  savePluginSettings,
  type PluginSettings,
} from "@/lib/settings"

const APP_VERSION = "0.0.1 (dev)"

const PANEL_WIDTH = 350;
const MAX_HEIGHT_FALLBACK_PX = 600;
const MAX_HEIGHT_FRACTION_OF_MONITOR = 0.8;

type PluginState = {
  data: PluginOutput | null
  loading: boolean
  error: string | null
}

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const containerRef = useRef<HTMLDivElement>(null);
  const [pluginStates, setPluginStates] = useState<Record<string, PluginState>>({})
  const [pluginsMeta, setPluginsMeta] = useState<PluginMeta[]>([])
  const [pluginSettings, setPluginSettings] = useState<PluginSettings | null>(null)
  const [maxPanelHeightPx, setMaxPanelHeightPx] = useState<number | null>(null)
  const maxPanelHeightPxRef = useRef<number | null>(null)

  const displayPlugins = useMemo(() => {
    if (!pluginSettings) return []
    const disabledSet = new Set(pluginSettings.disabled)
    const metaById = new Map(pluginsMeta.map((plugin) => [plugin.id, plugin]))
    return pluginSettings.order
      .filter((id) => !disabledSet.has(id))
      .map((id) => {
        const meta = metaById.get(id)
        if (!meta) return null
        const state = pluginStates[id] ?? { data: null, loading: false, error: null }
        return { meta, ...state }
      })
      .filter((plugin): plugin is { meta: PluginMeta } & PluginState => Boolean(plugin))
  }, [pluginSettings, pluginStates, pluginsMeta])

  // Initialize panel on mount
  useEffect(() => {
    invoke("init_panel").catch(console.error);
  }, []);

  // Auto-resize window to fit content using ResizeObserver
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const resizeWindow = async () => {
      const factor = window.devicePixelRatio;

      const width = Math.ceil(PANEL_WIDTH * factor);
      const desiredHeightLogical = Math.max(1, container.scrollHeight);

      let maxHeightPhysical: number | null = null;
      let maxHeightLogical: number | null = null;
      try {
        const currentWindow = getCurrentWindow();
        const monitor = await currentWindow.currentMonitor();
        if (monitor) {
          maxHeightPhysical = Math.floor(monitor.size.height * MAX_HEIGHT_FRACTION_OF_MONITOR);
          maxHeightLogical = Math.floor(maxHeightPhysical / factor);
        }
      } catch {
        // fall through to fallback
      }

      if (maxHeightLogical === null) {
        const screenAvailHeight = Number(window.screen?.availHeight) || MAX_HEIGHT_FALLBACK_PX;
        maxHeightLogical = Math.floor(screenAvailHeight * MAX_HEIGHT_FRACTION_OF_MONITOR);
        maxHeightPhysical = Math.floor(maxHeightLogical * factor);
      }

      if (maxPanelHeightPxRef.current !== maxHeightLogical) {
        maxPanelHeightPxRef.current = maxHeightLogical;
        setMaxPanelHeightPx(maxHeightLogical);
      }

      const desiredHeightPhysical = Math.ceil(desiredHeightLogical * factor);
      const height = Math.ceil(Math.min(desiredHeightPhysical, maxHeightPhysical!));

      try {
        const currentWindow = getCurrentWindow();
        await currentWindow.setSize(new PhysicalSize(width, height));
      } catch (e) {
        console.error("Failed to resize window:", e);
      }
    };

    // Initial resize
    resizeWindow();

    // Observe size changes
    const observer = new ResizeObserver(() => {
      resizeWindow();
    });
    observer.observe(container);

    return () => observer.disconnect();
  }, [activeTab, displayPlugins]);

  const getErrorMessage = useCallback((output: PluginOutput) => {
    if (output.lines.length !== 1) return null
    const line = output.lines[0]
    if (line.type === "badge" && line.label === "Error") {
      return line.text || "Couldn't update data. Try again?"
    }
    return null
  }, [])

  const setLoadingForPlugins = useCallback((ids: string[]) => {
    setPluginStates((prev) => {
      const next = { ...prev }
      for (const id of ids) {
        next[id] = { data: null, loading: true, error: null }
      }
      return next
    })
  }, [])

  const handleProbeResult = useCallback(
    (output: PluginOutput) => {
      const errorMessage = getErrorMessage(output)
      setPluginStates((prev) => ({
        ...prev,
        [output.providerId]: {
          data: errorMessage ? null : output,
          loading: false,
          error: errorMessage,
        },
      }))
    },
    [getErrorMessage]
  )

  const handleBatchComplete = useCallback(() => {}, [])

  const { startBatch } = useProbeEvents({
    onResult: handleProbeResult,
    onBatchComplete: handleBatchComplete,
  })

  useEffect(() => {
    let isMounted = true

    const loadSettings = async () => {
      try {
        const availablePlugins = await invoke<PluginMeta[]>("list_plugins")
        if (!isMounted) return
        setPluginsMeta(availablePlugins)

        const storedSettings = await loadPluginSettings()
        const normalized = normalizePluginSettings(
          storedSettings,
          availablePlugins
        )

        if (!arePluginSettingsEqual(storedSettings, normalized)) {
          await savePluginSettings(normalized)
        }

        if (isMounted) {
          setPluginSettings(normalized)
          const enabledIds = getEnabledPluginIds(normalized)
          setLoadingForPlugins(enabledIds)
          await startBatch(enabledIds)
        }
      } catch (e) {
        console.error("Failed to load plugin settings:", e)
      }
    }

    loadSettings()

    return () => {
      isMounted = false
    }
  }, [setLoadingForPlugins, startBatch])

  const handleRefresh = () => {
    if (!pluginSettings) return
    const enabledIds = getEnabledPluginIds(pluginSettings)
    setLoadingForPlugins(enabledIds)
    void startBatch(enabledIds)
  }

  const handleRetryPlugin = useCallback(
    (id: string) => {
      setLoadingForPlugins([id])
      void startBatch([id])
    },
    [setLoadingForPlugins, startBatch]
  )

  const settingsPlugins = useMemo(() => {
    if (!pluginSettings) return []
    const pluginMap = new Map(pluginsMeta.map((plugin) => [plugin.id, plugin]))
    return pluginSettings.order
      .map((id) => {
        const meta = pluginMap.get(id)
        if (!meta) return null
        return {
          id,
          name: meta.name,
          enabled: !pluginSettings.disabled.includes(id),
        }
      })
      .filter((plugin): plugin is { id: string; name: string; enabled: boolean } =>
        Boolean(plugin)
      )
  }, [pluginSettings, pluginsMeta])

  const handleReorder = useCallback(
    (orderedIds: string[]) => {
      if (!pluginSettings) return
      const nextSettings: PluginSettings = {
        ...pluginSettings,
        order: orderedIds,
      }
      setPluginSettings(nextSettings)
      void savePluginSettings(nextSettings).catch((error) => {
        console.error("Failed to save plugin order:", error)
      })
    },
    [pluginSettings]
  )

  const handleToggle = useCallback(
    (id: string) => {
      if (!pluginSettings) return
      const wasDisabled = pluginSettings.disabled.includes(id)
      const disabled = new Set(pluginSettings.disabled)

      if (wasDisabled) {
        disabled.delete(id)
        setLoadingForPlugins([id])
        void startBatch([id])
      } else {
        disabled.add(id)
        // No probe needed for disable
      }

      const nextSettings: PluginSettings = {
        ...pluginSettings,
        disabled: Array.from(disabled),
      }
      setPluginSettings(nextSettings)
      void savePluginSettings(nextSettings).catch((error) => {
        console.error("Failed to save plugin toggle:", error)
      })
    },
    [pluginSettings, setLoadingForPlugins, startBatch]
  )

  return (
    <div
      ref={containerRef}
      className="bg-card rounded-lg border shadow-lg overflow-hidden select-none"
      style={maxPanelHeightPx ? { maxHeight: `${maxPanelHeightPx}px` } : undefined}
    >
      <div className="p-4 flex h-full min-h-0 flex-col">
        <PanelHeader activeTab={activeTab} onTabChange={setActiveTab} />

        <div className="mt-3 flex-1 min-h-0 overflow-y-auto">
          {activeTab === "overview" ? (
            <OverviewPage
              plugins={displayPlugins}
              onRetryPlugin={handleRetryPlugin}
            />
          ) : (
            <SettingsPage
              plugins={settingsPlugins}
              onReorder={handleReorder}
              onToggle={handleToggle}
            />
          )}
        </div>

        <PanelFooter
          version={APP_VERSION}
          onRefresh={handleRefresh}
        />
      </div>
    </div>
  );
}

export default App;
