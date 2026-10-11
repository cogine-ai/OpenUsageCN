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

export const useAppUiStore = create<AppUiStore>((set) => ({
  ...initialState,
  setActiveView: (view) => set({ activeView: view, connection: null }),
  openConnection: (providerId, kind, focusField) => set({ connection: { providerId, kind, focusField } }),
  closeConnection: () => set({ connection: null }),
  setShowAbout: (value) => set({ showAbout: value }),
  resetState: () => set(initialState),
}))
