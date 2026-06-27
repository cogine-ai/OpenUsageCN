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
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { GlobalShortcutSection } from "@/components/global-shortcut-section";
import { LocalHttpApiSection } from "@/components/local-http-api-section";
import { ProviderConfigFields } from "@/components/provider-config-fields";
import type { PluginConfig as ManifestPluginConfig } from "@/lib/plugin-types";
import { getBarFillLayout, getTrayIconSizePx } from "@/lib/tray-bars-icon";
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
  type ResetTimerDisplayMode,
  type ThemeMode,
  type TimeFormatMode,
} from "@/lib/settings";
import { getTimeFormatter } from "@/lib/reset-tooltip";
import type { TraySettingsPreview } from "@/hooks/app/use-tray-icon";
import { cn } from "@/lib/utils";

interface PluginConfig {
  id: string;
  name: string;
  enabled: boolean;
  config?: ManifestPluginConfig;
}

const TRAY_PREVIEW_SIZE_PX = getTrayIconSizePx(1);

const PREVIEW_BAR_TRACK_PX = 20;

function getPreviewBarLayout(fraction: number): { fillPercent: number; remainderPercent: number } {
  const { fillW, remainderDrawW } = getBarFillLayout(PREVIEW_BAR_TRACK_PX, fraction);
  return {
    fillPercent: (fillW / PREVIEW_BAR_TRACK_PX) * 100,
    remainderPercent: (remainderDrawW / PREVIEW_BAR_TRACK_PX) * 100,
  };
}

function ProviderIconMask({
  iconUrl,
  isActive,
  sizePx,
}: {
  iconUrl?: string;
  isActive: boolean;
  sizePx: number;
}) {
  const colorClass = isActive ? "bg-primary-foreground" : "bg-foreground";
  if (iconUrl) {
    return (
      <div
        aria-hidden
        className={cn("shrink-0", colorClass)}
        style={{
          width: `${sizePx}px`,
          height: `${sizePx}px`,
          WebkitMaskImage: `url(${iconUrl})`,
          WebkitMaskSize: "contain",
          WebkitMaskRepeat: "no-repeat",
          WebkitMaskPosition: "center",
          maskImage: `url(${iconUrl})`,
          maskSize: "contain",
          maskRepeat: "no-repeat",
          maskPosition: "center",
        }}
      />
    );
  }
  const textClass = isActive ? "text-primary-foreground" : "text-foreground";
  return (
    <svg aria-hidden viewBox="0 0 26 26" className={cn("shrink-0", textClass)} style={{ width: `${sizePx}px`, height: `${sizePx}px` }}>
      <circle cx="13" cy="13" r="9" fill="none" stroke="currentColor" strokeWidth="3.5" opacity={0.3} />
    </svg>
  );
}

function MenubarIconStylePreview({
  style,
  isActive,
  traySettingsPreview,
}: {
  style: MenubarIconStyle;
  isActive: boolean;
  traySettingsPreview: TraySettingsPreview;
}) {
  const textClass = isActive ? "text-primary-foreground" : "text-foreground";

  if (style === "provider") {
    return (
      <div className="inline-flex items-center gap-0.5">
        <ProviderIconMask
          iconUrl={traySettingsPreview.providerIconUrl}
          isActive={isActive}
          sizePx={TRAY_PREVIEW_SIZE_PX}
        />
        <span className={cn("text-[12px] font-semibold tabular-nums leading-none", textClass)}>
          {traySettingsPreview.providerPercentText}
        </span>
      </div>
    );
  }

  if (style === "bars") {
    const trackClass = isActive ? "bg-primary-foreground/15" : "bg-foreground/15";
    const remainderClass = isActive ? "bg-primary-foreground/20" : "bg-foreground/15";
    const fillClass = isActive ? "bg-primary-foreground" : "bg-foreground";
    const fractions = traySettingsPreview.bars.length > 0
      ? traySettingsPreview.bars.map((b) => b.fraction ?? 0)
      : [0.83, 0.7, 0.56];

    return (
      <div className="flex items-center">
        <div className="flex flex-col gap-0.5 w-5">
          {fractions.map((fraction, i) => {
            const { fillPercent, remainderPercent } = getPreviewBarLayout(fraction);
            return (
              <div key={i} className={cn("relative h-1 rounded-sm", trackClass)}>
                {remainderPercent > 0 && (
                  <span
                    aria-hidden
                    className={remainderClass}
                    style={{
                      position: "absolute",
                      right: 0,
                      top: 0,
                      bottom: 0,
                      width: `${remainderPercent}%`,
                      borderRadius: "1px 2px 2px 1px",
                    }}
                  />
                )}
                <div
                  className={cn("h-1", fillClass)}
                  style={{ width: `${fillPercent}%`, borderRadius: "2px 1px 1px 2px" }}
                />
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (style === "donut") {
    const fraction = traySettingsPreview.providerBars[0]?.fraction ?? 0;
    const clamped = Math.max(0, Math.min(1, fraction));
    return (
      <div className="inline-flex items-center gap-1">
        <ProviderIconMask
          iconUrl={traySettingsPreview.providerIconUrl}
          isActive={isActive}
          sizePx={TRAY_PREVIEW_SIZE_PX}
        />
        <svg aria-hidden viewBox="0 0 26 26" className={cn("shrink-0", textClass)} style={{ width: `${TRAY_PREVIEW_SIZE_PX}px`, height: `${TRAY_PREVIEW_SIZE_PX}px` }}>
          <circle
            cx="13" cy="13" r="9"
            fill="none" stroke="currentColor" strokeWidth="4"
            opacity={isActive ? 0.2 : 0.15}
          />
          {clamped > 0 && (
            <circle
              cx="13" cy="13" r="9"
              fill="none" stroke="currentColor" strokeWidth="4"
              strokeLinecap="butt"
              pathLength="100"
              strokeDasharray={`${Math.round(clamped * 100)} 100`}
              transform="rotate(-90 13 13)"
            />
          )}
        </svg>
      </div>
    );
  }

  return null;
}

function SortablePluginItem({
  plugin,
  onToggle,
  onProviderConfigSaved,
}: {
  plugin: PluginConfig;
  onToggle: (id: string) => void;
  onProviderConfigSaved: (id: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: plugin.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "rounded-md bg-card",
        "border border-transparent",
        isDragging && "opacity-50 border-border"
      )}
    >
      <div
        onClick={() => onToggle(plugin.id)}
        className="flex cursor-pointer items-center gap-3 px-3 py-2"
      >
        <button
          type="button"
          aria-label="拖拽排序"
          onClick={(e) => e.stopPropagation()}
          className="touch-none cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground transition-colors"
          {...attributes}
          {...listeners}
        >
          <span aria-hidden className="grid h-4 w-4 grid-cols-2 gap-0.5 p-0.5">
            {Array.from({ length: 6 }).map((_, index) => (
              <span key={index} className="h-1 w-1 rounded-full bg-current" />
            ))}
          </span>
        </button>

        <span
          className={cn(
            "flex-1 text-sm",
            !plugin.enabled && "text-muted-foreground"
          )}
        >
          {plugin.name}
        </span>

        {/* Wrap to stop Base UI's internal input.click() from bubbling to the row div */}
        <span onClick={(e) => e.stopPropagation()}>
          <Checkbox
            key={`${plugin.id}-${plugin.enabled}`}
            checked={plugin.enabled}
            onCheckedChange={() => onToggle(plugin.id)}
          />
        </span>
      </div>

      {plugin.config?.fields.length ? (
        <div
          className="px-3 pb-3"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <ProviderConfigFields
            pluginId={plugin.id}
            fields={plugin.config.fields}
            onSaved={onProviderConfigSaved}
          />
        </div>
      ) : null}
    </div>
  );
}

interface SettingsPageProps {
  plugins: PluginConfig[];
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
}

export function SettingsPage({
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
      <GlobalShortcutSection
        globalShortcut={globalShortcut}
        onGlobalShortcutChange={onGlobalShortcutChange}
      />
      <LocalHttpApiSection />
      <section>
        <h3 className="text-lg font-semibold mb-0">登录时启动</h3>
        <p className="text-sm text-muted-foreground mb-2">
          登录后自动打开 OpenUsageCN
        </p>
        <label className="flex items-center gap-2 text-sm select-none text-foreground">
          <Checkbox
            key={`start-on-login-${startOnLogin}`}
            checked={startOnLogin}
            onCheckedChange={(checked) => onStartOnLoginChange(checked === true)}
          />
          登录时启动
        </label>
      </section>
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
