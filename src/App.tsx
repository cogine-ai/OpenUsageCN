import { useCallback, useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { getCurrentWindow, PhysicalSize } from "@tauri-apps/api/window"
import { PanelHeader, type Tab } from "@/components/panel-header"
import { PanelFooter } from "@/components/panel-footer"
import { OverviewPage } from "@/pages/overview"
import { SettingsPage } from "@/pages/settings"
import { APP_VERSION } from "@/lib/mock-data"
import type { PluginOutput } from "@/lib/plugin-types"

const PANEL_WIDTH = 350;
const MAX_HEIGHT = 600;

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const containerRef = useRef<HTMLDivElement>(null);
  const [providers, setProviders] = useState<PluginOutput[]>([])

  // Initialize panel on mount
  useEffect(() => {
    invoke("init_panel").catch(console.error);
  }, []);

  // Auto-resize window to fit content using ResizeObserver
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const resizeWindow = async () => {
      const rect = container.getBoundingClientRect();
      const factor = window.devicePixelRatio;

      const width = Math.ceil(PANEL_WIDTH * factor);
      const height = Math.ceil(Math.min(rect.height, MAX_HEIGHT) * factor);

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
  }, [activeTab, providers]);

  const loadProviders = useCallback(async () => {
    try {
      const results = await invoke<PluginOutput[]>("run_plugin_probes")
      setProviders(results)
    } catch (e) {
      console.error("Failed to load plugins:", e)
    }
  }, [])

  useEffect(() => {
    loadProviders()
  }, [loadProviders])

  const handleRefresh = () => {
    loadProviders()
  }

  return (
    <div
      ref={containerRef}
      className="bg-card rounded-lg border shadow-lg overflow-hidden select-none"
    >
      <div className="p-4 flex flex-col">
        <PanelHeader activeTab={activeTab} onTabChange={setActiveTab} />

        <div className="mt-3">
          {activeTab === "overview" ? (
            <OverviewPage providers={providers} />
          ) : (
            <SettingsPage />
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
