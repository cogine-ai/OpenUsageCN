import { Skeleton } from "@/components/ui/skeleton"
import type { ManifestLine } from "@/lib/plugin-types"

function SkeletonText({ label }: { label: string }) {
  return (
    <div className="flex justify-between items-center h-[22px]">
      <span className="text-sm text-muted-foreground">{label}</span>
      <Skeleton className="h-4 w-16" />
    </div>
  )
}

function SkeletonBadge({ label }: { label: string }) {
  return (
    <div className="flex justify-between items-center h-[22px]">
      <span className="text-sm text-muted-foreground">{label}</span>
      <Skeleton className="h-5 w-16 rounded-full" />
    </div>
  )
}

function SkeletonProgress({ label }: { label: string }) {
  return (
    <div className="flex justify-between items-center h-[22px]">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <Skeleton className="h-4 w-12" />
        <Skeleton className="h-2 w-24 rounded-full" />
      </div>
    </div>
  )
}

export function SkeletonLine({ line }: { line: ManifestLine }) {
  switch (line.type) {
    case "text":
      return <SkeletonText label={line.label} />
    case "badge":
      return <SkeletonBadge label={line.label} />
    case "progress":
      return <SkeletonProgress label={line.label} />
    default:
      return <SkeletonText label={line.label} />
  }
}

export function SkeletonLines({ lines }: { lines: ManifestLine[] }) {
  return (
    <div className="space-y-1">
      {lines.map((line, index) => (
        <SkeletonLine key={`${line.label}-${index}`} line={line} />
      ))}
    </div>
  )
}
