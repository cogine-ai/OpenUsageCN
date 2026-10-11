import type { PaceNotificationMilestone } from "@/lib/pace-notification-logic"
import { Progress } from "@/components/ui/progress"

/** Illustrates each alert threshold without representing a live provider prediction. */
export function PaceNotificationPreview({ kind }: { kind: PaceNotificationMilestone }) {
  if (kind === "almostOut") {
    return (
      <div className="mt-1 flex items-center gap-2" role="img" aria-label="额度剩余不足 10%">
        <div aria-hidden className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full w-[8%] rounded-full bg-red-500" />
        </div>
        <span className="shrink-0 text-[10px] tabular-nums text-red-600 dark:text-red-400">剩余 &lt;10%</span>
      </div>
    )
  }
  const behind = kind === "runningOut"
  return (
    <div className="mt-1" role="img" aria-label={behind ? "预计用尽早于重置" : "预计在重置时接近上限"}>
      <Progress aria-hidden className="h-1.5" value={behind ? 62 : 72}
        markerValue={behind ? 40 : undefined} indicatorColor={behind ? "#ef4444" : "#f59e0b"} />
      <p className={`mt-1 text-[10px] ${behind ? "text-red-600 dark:text-red-400" : "text-amber-700 dark:text-amber-400"}`}>
        {behind ? "预计在重置前用尽" : "重置时预计接近上限"}
      </p>
    </div>
  )
}
