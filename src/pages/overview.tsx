import { ProviderCard } from "@/components/provider-card"
import type { PluginOutput } from "@/lib/plugin-types"

interface OverviewPageProps {
  providers: PluginOutput[]
}

export function OverviewPage({ providers }: OverviewPageProps) {
  return (
    <div>
      {providers.map((provider, index) => (
        <ProviderCard
          key={provider.providerId}
          name={provider.displayName}
          lines={provider.lines}
          showSeparator={index < providers.length - 1}
        />
      ))}
    </div>
  )
}
