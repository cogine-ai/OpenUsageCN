import { create } from "zustand"
import {
  DEFAULT_AUTO_UPDATE_INTERVAL,
  DEFAULT_DISPLAY_MODE,
  DEFAULT_GLOBAL_SHORTCUT,
  DEFAULT_MENUBAR_ICON_STYLE,
  DEFAULT_MENUBAR_METRIC,
  DEFAULT_PACE_NOTIFICATION_SETTINGS,
  DEFAULT_RESET_TIMER_DISPLAY_MODE,
  DEFAULT_START_ON_LOGIN,
  DEFAULT_THEME_MODE,
  DEFAULT_TIME_FORMAT_MODE,
  type AutoUpdateIntervalMinutes,
  type DisplayMode,
  type GlobalShortcut,
  type MenubarIconStyle,
  type MenubarMetric,
  type PaceNotificationSettings,
  type ResetTimerDisplayMode,
  type ThemeMode,
  type TimeFormatMode,
} from "@/lib/settings"

type AppPreferencesStore = {
  autoUpdateInterval: AutoUpdateIntervalMinutes
  themeMode: ThemeMode
  displayMode: DisplayMode
  resetTimerDisplayMode: ResetTimerDisplayMode
  timeFormatMode: TimeFormatMode
  globalShortcut: GlobalShortcut
  startOnLogin: boolean
  menubarIconStyle: MenubarIconStyle
  menubarMetric: MenubarMetric
  paceNotifications: PaceNotificationSettings
  setAutoUpdateInterval: (value: AutoUpdateIntervalMinutes) => void
  setThemeMode: (value: ThemeMode) => void
  setDisplayMode: (value: DisplayMode) => void
  setResetTimerDisplayMode: (value: ResetTimerDisplayMode) => void
  setTimeFormatMode: (value: TimeFormatMode) => void
  setGlobalShortcut: (value: GlobalShortcut) => void
  setStartOnLogin: (value: boolean) => void
  setMenubarIconStyle: (value: MenubarIconStyle) => void
  setMenubarMetric: (value: MenubarMetric) => void
  setPaceNotifications: (value: PaceNotificationSettings) => void
  resetState: () => void
}

const initialState = {
  autoUpdateInterval: DEFAULT_AUTO_UPDATE_INTERVAL,
  themeMode: DEFAULT_THEME_MODE,
  displayMode: DEFAULT_DISPLAY_MODE,
  resetTimerDisplayMode: DEFAULT_RESET_TIMER_DISPLAY_MODE,
  timeFormatMode: DEFAULT_TIME_FORMAT_MODE,
  globalShortcut: DEFAULT_GLOBAL_SHORTCUT,
  startOnLogin: DEFAULT_START_ON_LOGIN,
  menubarIconStyle: DEFAULT_MENUBAR_ICON_STYLE,
  menubarMetric: DEFAULT_MENUBAR_METRIC,
  paceNotifications: DEFAULT_PACE_NOTIFICATION_SETTINGS,
}

export const useAppPreferencesStore = create<AppPreferencesStore>((set) => ({
  ...initialState,
  setAutoUpdateInterval: (value) => set({ autoUpdateInterval: value }),
  setThemeMode: (value) => set({ themeMode: value }),
  setDisplayMode: (value) => set({ displayMode: value }),
  setResetTimerDisplayMode: (value) => set({ resetTimerDisplayMode: value }),
  setTimeFormatMode: (value) => set({ timeFormatMode: value }),
  setGlobalShortcut: (value) => set({ globalShortcut: value }),
  setStartOnLogin: (value) => set({ startOnLogin: value }),
  setMenubarIconStyle: (value) => set({ menubarIconStyle: value }),
  setMenubarMetric: (value) => set({ menubarMetric: value }),
  setPaceNotifications: (value) => set({ paceNotifications: value }),
  resetState: () => set(initialState),
}))
