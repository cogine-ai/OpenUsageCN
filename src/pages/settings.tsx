import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { GlobalShortcutSection } from "@/components/global-shortcut-section";
import { LocalHttpApiSection } from "@/components/local-http-api-section";
import { CliSection } from "@/components/cli-section";
import { MenubarIconStylePreview } from "@/components/menubar-icon-style-preview";
import { PaceNotificationSettingsSection } from "@/components/pace-notification-settings";
import { SortablePluginItem, type SettingsPluginConfig } from "@/components/settings-plugin-item";
import {
  AUTO_UPDATE_OPTIONS,
  DISPLAY_MODE_OPTIONS,
  MENUBAR_ICON_STYLE_OPTIONS,
  MENUBAR_METRIC_OPTIONS,
  RESET_TIMER_DISPLAY_OPTIONS,
  THEME_OPTIONS,
  TIME_FORMAT_OPTIONS,
  type AutoUpdateIntervalMinutes,
  type DisplayMode,
  type GlobalShortcut,
  type MenubarIconStyle,
  type MenubarMetric,
  type PaceNotificationSettings,
  type ResetTimerDisplayMode,
  type ThemeMode,
  type TimeFormatMode,
} from "@/lib/settings";
import { getTimeFormatter } from "@/lib/reset-tooltip";
import type { TraySettingsPreview } from "@/hooks/app/use-tray-icon";
import { cn } from "@/lib/utils";
import type { PlatformCapabilities } from "@/lib/platform-capabilities";

interface SettingsPageProps {
  platformCapabilities: PlatformCapabilities | null;
  plugins: SettingsPluginConfig[];
  onReorder: (orderedIds: string[]) => void;
  onToggle: (id: string) => void;
  onProviderConfigSaved: (id: string) => void;
  autoUpdateInterval: AutoUpdateIntervalMinutes;
  onAutoUpdateIntervalChange: (value: AutoUpdateIntervalMinutes) => void;
  themeMode: ThemeMode;
  onThemeModeChange: (value: ThemeMode) => void;
  displayMode: DisplayMode;
  onDisplayModeChange: (value: DisplayMode) => void;
  resetTimerDisplayMode: ResetTimerDisplayMode;
  onResetTimerDisplayModeChange: (value: ResetTimerDisplayMode) => void;
  timeFormatMode: TimeFormatMode;
  onTimeFormatModeChange: (value: TimeFormatMode) => void;
  menubarIconStyle: MenubarIconStyle;
  onMenubarIconStyleChange: (value: MenubarIconStyle) => void;
  menubarMetric: MenubarMetric;
  onMenubarMetricChange: (value: MenubarMetric) => void;
  traySettingsPreview: TraySettingsPreview;
  globalShortcut: GlobalShortcut;
  onGlobalShortcutChange: (value: GlobalShortcut) => void;
  startOnLogin: boolean;
  onStartOnLoginChange: (value: boolean) => void;
  paceNotifications: PaceNotificationSettings;
  onPaceNotificationsChange: (value: PaceNotificationSettings) => Promise<void>;
}

export function SettingsPage({
  platformCapabilities,
  plugins,
  onReorder,
  onToggle,
  onProviderConfigSaved,
  autoUpdateInterval,
  onAutoUpdateIntervalChange,
  themeMode,
  onThemeModeChange,
  displayMode,
  onDisplayModeChange,
  resetTimerDisplayMode,
  onResetTimerDisplayModeChange,
  timeFormatMode,
  onTimeFormatModeChange,
  menubarIconStyle,
  onMenubarIconStyleChange,
  menubarMetric,
  onMenubarMetricChange,
  traySettingsPreview,
  globalShortcut,
  onGlobalShortcutChange,
  startOnLogin,
  onStartOnLoginChange,
  paceNotifications,
  onPaceNotificationsChange,
}: SettingsPageProps) {
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = plugins.findIndex((item) => item.id === active.id);
      const newIndex = plugins.findIndex((item) => item.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;
      const next = arrayMove(plugins, oldIndex, newIndex);
      onReorder(next.map((item) => item.id));
    }
  };

  return (
    <div className="py-3 space-y-4">
      <section>
        <h3 className="text-lg font-semibold mb-0">自动刷新</h3>
        <p className="text-sm text-muted-foreground mb-2">
          选择刷新频率
        </p>
        <div className="bg-muted/50 rounded-lg p-1">
          <div className="flex gap-1" role="radiogroup" aria-label="自动刷新频率">
            {AUTO_UPDATE_OPTIONS.map((option) => {
              const isActive = option.value === autoUpdateInterval;
              return (
                <Button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  variant={isActive ? "default" : "outline"}
                  size="sm"
                  className="flex-1"
                  onClick={() => onAutoUpdateIntervalChange(option.value)}
                >
                  {option.label}
                </Button>
              );
            })}
          </div>
        </div>
      </section>
      {platformCapabilities?.paceNotifications ? (
        <PaceNotificationSettingsSection
          value={paceNotifications}
          onChange={onPaceNotificationsChange}
        />
      ) : null}
      <section>
        <h3 className="text-lg font-semibold mb-0">用量显示</h3>
        <p className="text-sm text-muted-foreground mb-2">
          显示已用或剩余
        </p>
        <div className="bg-muted/50 rounded-lg p-1">
          <div className="flex gap-1" role="radiogroup" aria-label="用量显示方式">
            {DISPLAY_MODE_OPTIONS.map((option) => {
              const isActive = option.value === displayMode;
              return (
                <Button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  variant={isActive ? "default" : "outline"}
                  size="sm"
                  className="flex-1"
                  onClick={() => onDisplayModeChange(option.value)}
                >
                  {option.label}
                </Button>
              );
            })}
          </div>
        </div>
      </section>
      <section>
        <h3 className="text-lg font-semibold mb-0">重置时间</h3>
        <p className="text-sm text-muted-foreground mb-2">
          倒计时或具体时间
        </p>
        <div className="bg-muted/50 rounded-lg p-1">
          <div className="flex gap-1" role="radiogroup" aria-label="重置时间显示">
            {RESET_TIMER_DISPLAY_OPTIONS.map((option) => {
              const isActive = option.value === resetTimerDisplayMode;
              const absoluteTimeExample = getTimeFormatter(timeFormatMode).format(new Date(2026, 1, 2, 11, 4));
              const example = option.value === "relative" ? "5 小时 12 分钟" : `今日 ${absoluteTimeExample}`;
              return (
                <Button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  variant={isActive ? "default" : "outline"}
                  size="sm"
                  className="flex-1 flex flex-col items-center gap-0 py-2 h-auto"
                  onClick={() => onResetTimerDisplayModeChange(option.value)}
                >
                  <span>{option.label}</span>
                  <span
                    className={cn(
                      "text-xs font-normal",
                      isActive ? "text-primary-foreground/80" : "text-muted-foreground"
                    )}
                  >
                    {example}
                  </span>
                </Button>
              );
            })}
          </div>
        </div>
      </section>
      <section>
        <h3 className="text-lg font-semibold mb-0">时间格式</h3>
        <p className="text-sm text-muted-foreground mb-2">
          选择 12/24 小时制
        </p>
        <div className="bg-muted/50 rounded-lg p-1">
          <div className="flex gap-1" role="radiogroup" aria-label="时间格式">
            {TIME_FORMAT_OPTIONS.map((option) => {
              const isActive = option.value === timeFormatMode;
              const example = getTimeFormatter(option.value).format(new Date(2026, 1, 2, 11, 4));
              return (
                <Button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  aria-label={option.label}
                  variant={isActive ? "default" : "outline"}
                  size="sm"
                  className="flex-1 flex flex-col items-center gap-0 py-2 h-auto"
                  onClick={() => onTimeFormatModeChange(option.value)}
                >
                  <span>{option.label}</span>
                  <span
                    className={cn(
                      "text-xs font-normal",
                      isActive ? "text-primary-foreground/80" : "text-muted-foreground"
                    )}
                  >
                    {example}
                  </span>
                </Button>
              );
            })}
          </div>
        </div>
      </section>
      {platformCapabilities?.dynamicTrayIconSettings ? (
        <section>
          <h3 className="text-lg font-semibold mb-0">菜单栏图标</h3>
          <p className="text-sm text-muted-foreground mb-2">
            设置菜单栏显示样式
          </p>
          <div className="bg-muted/50 rounded-lg p-1">
            <div className="flex gap-1" role="radiogroup" aria-label="菜单栏图标样式">
              {MENUBAR_ICON_STYLE_OPTIONS.map((option) => {
                const isActive = option.value === menubarIconStyle;
                return (
                  <Button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-label={option.label}
                    aria-checked={isActive}
                    variant={isActive ? "default" : "outline"}
                    size="sm"
                    className="flex-1 h-9 flex items-center justify-center"
                    onClick={() => onMenubarIconStyleChange(option.value)}
                  >
                    <MenubarIconStylePreview
                      style={option.value}
                      isActive={isActive}
                      traySettingsPreview={traySettingsPreview}
                    />
                  </Button>
                );
              })}
            </div>
          </div>
          <p className="text-sm text-muted-foreground mt-3 mb-2">指标</p>
          <div className="bg-muted/50 rounded-lg p-1">
            <div className="flex gap-1" role="radiogroup" aria-label="菜单栏指标">
              {MENUBAR_METRIC_OPTIONS.map((option) => {
                const isActive = option.value === menubarMetric;
                return (
                  <Button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-label={option.label}
                    aria-checked={isActive}
                    variant={isActive ? "default" : "outline"}
                    size="sm"
                    className="flex-1"
                    onClick={() => onMenubarMetricChange(option.value)}
                  >
                    {option.label}
                  </Button>
                );
              })}
            </div>
          </div>
        </section>
      ) : null}
      <section>
        <h3 className="text-lg font-semibold mb-0">应用主题</h3>
        <p className="text-sm text-muted-foreground mb-2">
          选择界面外观
        </p>
        <div className="bg-muted/50 rounded-lg p-1">
          <div className="flex gap-1" role="radiogroup" aria-label="主题模式">
            {THEME_OPTIONS.map((option) => {
              const isActive = option.value === themeMode;
              return (
                <Button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  variant={isActive ? "default" : "outline"}
                  size="sm"
                  className="flex-1"
                  onClick={() => onThemeModeChange(option.value)}
                >
                  {option.label}
                </Button>
              );
            })}
          </div>
        </div>
      </section>
      {platformCapabilities?.globalShortcuts ? (
        <GlobalShortcutSection
          globalShortcut={globalShortcut}
          onGlobalShortcutChange={onGlobalShortcutChange}
        />
      ) : null}
      {platformCapabilities?.localHttpApi ? <LocalHttpApiSection /> : null}
      {platformCapabilities?.cli ? <CliSection /> : null}
      {platformCapabilities?.autostart ? (
        <section>
          <h3 className="text-lg font-semibold mb-0">登录时启动</h3>
          <p className="text-sm text-muted-foreground mb-2">
            登录后自动打开 OpenUsageCN
          </p>
          <label className="flex items-center gap-2 text-sm select-none text-foreground">
            <Checkbox
              aria-label="登录时启动"
              key={`start-on-login-${startOnLogin}`}
              checked={startOnLogin}
              onCheckedChange={(checked) => onStartOnLoginChange(checked === true)}
            />
            登录时启动
          </label>
        </section>
      ) : null}
      <section>
        <h3 className="text-lg font-semibold mb-0">插件</h3>
        <p className="text-sm text-muted-foreground mb-2">
          选择要显示的服务商
        </p>
        <div className="bg-muted/50 rounded-lg p-1 space-y-1">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={plugins.map((p) => p.id)}
              strategy={verticalListSortingStrategy}
            >
              {plugins.map((plugin) => (
                <SortablePluginItem
                  key={plugin.id}
                  plugin={plugin}
                  onToggle={onToggle}
                  onProviderConfigSaved={onProviderConfigSaved}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
      </section>
    </div>
  );
}
