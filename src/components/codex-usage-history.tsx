import { useState } from "react"
import { usePlatformCapabilities } from "@/hooks/app/use-platform-capabilities"
import { LocalUsageHistory } from "@/components/local-usage-history"
import { ServerUsageReports } from "@/components/server-usage-reports"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

/** Keeps official reports and local estimates separate, including their pending requests. */
export function CodexUsageHistory({ sourceRefreshing, lastUpdatedAt }: {
  sourceRefreshing: boolean
  lastUpdatedAt: number | null
}) {
  const capabilities = usePlatformCapabilities()
  const [source, setSource] = useState("official")
  const localAvailable = capabilities !== null && capabilities.platform !== "windows"
  return (
    <section aria-label="用量历史" className="mt-4 space-y-3 rounded-lg border border-border bg-background p-3">
      <h3 className="text-sm font-semibold">用量历史</h3>
      <Tabs value={source} onValueChange={setSource}>
        <TabsList aria-label="历史来源" className="w-full">
          <TabsTrigger value="official">官方统计</TabsTrigger>
          {localAvailable ? <TabsTrigger value="local">本机估算</TabsTrigger> : null}
        </TabsList>
        <TabsContent value="official">
          {source === "official" ? <ServerUsageReports
            key={`codex:${sourceRefreshing}:${lastUpdatedAt}`}
            providerId="codex" sourceRefreshing={sourceRefreshing} embedded
          /> : null}
        </TabsContent>
        {localAvailable ? <TabsContent value="local">
          {source === "local" ? <LocalUsageHistory providerId="codex" embedded /> : null}
        </TabsContent> : null}
      </Tabs>
    </section>
  )
}
