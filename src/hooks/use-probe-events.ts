import { useCallback, useEffect, useRef } from "react"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { invoke } from "@tauri-apps/api/core"
import type { PluginOutput } from "@/lib/plugin-types"

type ProbeResult = {
  batchId: string
  output: PluginOutput
}

type ProbeBatchComplete = {
  batchId: string
}

type ProbeBatchStarted = {
  batchId: string
  pluginIds: string[]
}

type UseProbeEventsOptions = {
  onResult: (output: PluginOutput) => void
  onBatchComplete: () => void
}

export function useProbeEvents({ onResult, onBatchComplete }: UseProbeEventsOptions) {
  const activeBatchId = useRef<string | null>(null)
  const unlisteners = useRef<UnlistenFn[]>([])

  useEffect(() => {
    const setup = async () => {
      const resultUnlisten = await listen<ProbeResult>("probe:result", (event) => {
        if (event.payload.batchId === activeBatchId.current) {
          onResult(event.payload.output)
        }
      })

      const completeUnlisten = await listen<ProbeBatchComplete>(
        "probe:batch-complete",
        (event) => {
          if (event.payload.batchId === activeBatchId.current) {
            activeBatchId.current = null
            onBatchComplete()
          }
        }
      )

      unlisteners.current.push(resultUnlisten, completeUnlisten)
    }

    setup()

    return () => {
      unlisteners.current.forEach((unlisten) => unlisten())
      unlisteners.current = []
    }
  }, [onBatchComplete, onResult])

  const startBatch = useCallback(async (pluginIds?: string[]) => {
    const args = pluginIds ? { pluginIds } : undefined
    const result = await invoke<ProbeBatchStarted>("start_probe_batch", args)
    activeBatchId.current = result.batchId
    return result.pluginIds
  }, [])

  return { startBatch }
}
