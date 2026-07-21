import { useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import type { PlatformCapabilities } from "@/lib/platform-capabilities"

export function usePlatformCapabilities(): PlatformCapabilities | null {
  const [capabilities, setCapabilities] = useState<PlatformCapabilities | null>(null)

  useEffect(() => {
    let cancelled = false

    invoke<PlatformCapabilities>("get_platform_capabilities")
      .then((value) => {
        if (!cancelled) setCapabilities(value)
      })
      .catch((error) => {
        console.error("Failed to load platform capabilities:", error)
      })

    return () => {
      cancelled = true
    }
  }, [])

  return capabilities
}
