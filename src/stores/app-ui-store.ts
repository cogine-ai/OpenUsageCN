import { create } from "zustand"
import type { ActiveView } from "@/components/side-nav"

type AppUiStore = {
  activeView: ActiveView
  connection: { providerId: string; kind: "config" | "accounts" | "local"; focusField?: string } | null
  openConnection: (providerId: string, kind: "config" | "accounts" | "local", focusField?: string) => void
  closeConnection: () => void
  showAbout: boolean
  setActiveView: (view: ActiveView) => void
  setShowAbout: (value: boolean) => void
  resetState: () => void
}

const initialState = {
  activeView: "home" as ActiveView,
  showAbout: false,
  connection: null,
}

/** Share navigation and the focused connection sheet across overview, settings, and recovery actions. */
export const useAppUiStore = create<AppUiStore>((set) => ({
  ...initialState,
  /** Close the connection sheet whenever the main destination changes. */
  setActiveView: (view) => set({ activeView: view, connection: null }),
  /** Open the declared connection route, optionally focusing the credential that needs attention. */
  openConnection: (providerId, kind, focusField) => set({ connection: { providerId, kind, focusField } }),
  /** Dismiss connection controls without changing the underlying view. */
  closeConnection: () => set({ connection: null }),
  /** Control the About sheet independently of provider navigation. */
  setShowAbout: (value) => set({ showAbout: value }),
  /** Restore the initial home view and close transient sheets. */
  resetState: () => set(initialState),
}))
