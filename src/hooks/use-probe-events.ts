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

type ProbeBatchMeta = {
  batchId: string
  manual: boolean
  previous: ProbeBatchMeta | undefined
  failed: boolean
  resultReceived: boolean
}

export type ProbeResultContext = {
  manual: boolean
}

export type StartBatchOptions = {
  manual?: boolean
  invalidatePreviousOnFailure?: boolean
}

export type StartBatch = (
  pluginIds: string[],
  options?: StartBatchOptions
) => Promise<string[]>

export class ProbeBatchStartError extends Error {
  readonly cause: unknown
  readonly pluginIds: string[]

  constructor(cause: unknown, pluginIds: string[]) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = "ProbeBatchStartError"
    this.cause = cause
    this.pluginIds = pluginIds
  }
}

export function getProbeBatchStartFailedPluginIds(
  error: unknown,
  fallback: string[]
): string[] {
  return error instanceof ProbeBatchStartError ? error.pluginIds : fallback
}

type UseProbeEventsOptions = {
  onResult: (output: PluginOutput, context: ProbeResultContext) => void
  onBatchComplete: () => void
}

export function useProbeEvents({ onResult, onBatchComplete }: UseProbeEventsOptions) {
  const activeBatchIds = useRef<Set<string>>(new Set())
  const latestBatchByProvider = useRef<Map<string, ProbeBatchMeta>>(new Map())
  const startRequestTailByProvider = useRef<Map<string, Promise<void>>>(
    new Map()
  )
  const unlisteners = useRef<UnlistenFn[]>([])
  const listenersReadyRef = useRef<Promise<void> | null>(null)
  const listenersReadyResolveRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    let cancelled = false

    // Create the promise that will resolve when listeners are ready
    listenersReadyRef.current = new Promise<void>((resolve) => {
      listenersReadyResolveRef.current = resolve
    })

    const setup = async () => {
      const resultUnlisten = await listen<ProbeResult>("probe:result", (event) => {
        const latestBatch = latestBatchByProvider.current.get(
          event.payload.output.providerId
        )
        let eventBatch = latestBatch
        while (eventBatch && eventBatch.batchId !== event.payload.batchId) {
          eventBatch = eventBatch.previous
        }
        if (eventBatch) {
          eventBatch.resultReceived = true
        }
        if (
          activeBatchIds.current.has(event.payload.batchId) &&
          eventBatch !== undefined &&
          eventBatch === latestBatch
        ) {
          onResult(event.payload.output, { manual: latestBatch.manual })
        }
      })

      if (cancelled) {
        resultUnlisten()
        return
      }

      const completeUnlisten = await listen<ProbeBatchComplete>(
        "probe:batch-complete",
        (event) => {
          if (activeBatchIds.current.delete(event.payload.batchId)) {
            onBatchComplete()
          }
        }
      )

      if (cancelled) {
        resultUnlisten()
        completeUnlisten()
        return
      }

      unlisteners.current.push(resultUnlisten, completeUnlisten)

      // Signal that listeners are ready
      listenersReadyResolveRef.current?.()
    }

    void setup()

    return () => {
      cancelled = true
      unlisteners.current.forEach((unlisten) => unlisten())
      unlisteners.current = []
      listenersReadyRef.current = null
      listenersReadyResolveRef.current = null
    }
  }, [onBatchComplete, onResult])

  const startBatch = useCallback(async (
    pluginIds: string[],
    options: StartBatchOptions = {}
  ) => {
    const batchId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `batch-${Date.now()}-${Math.random().toString(16).slice(2)}`

    activeBatchIds.current.add(batchId)
    const batchMetaByProvider = new Map<string, ProbeBatchMeta>()
    for (const pluginId of new Set(pluginIds)) {
      const batchMeta: ProbeBatchMeta = {
        batchId,
        manual: options.manual === true,
        previous: latestBatchByProvider.current.get(pluginId),
        failed: false,
        resultReceived: false,
      }
      batchMetaByProvider.set(pluginId, batchMeta)
      latestBatchByProvider.current.set(pluginId, batchMeta)
    }

    const previousStartRequests = new Set<Promise<void>>()
    for (const pluginId of batchMetaByProvider.keys()) {
      const previousStartRequest = startRequestTailByProvider.current.get(pluginId)
      if (previousStartRequest) previousStartRequests.add(previousStartRequest)
    }
    let releaseStartRequest = () => {}
    const startRequest = new Promise<void>((resolve) => {
      releaseStartRequest = resolve
    })
    for (const pluginId of batchMetaByProvider.keys()) {
      startRequestTailByProvider.current.set(pluginId, startRequest)
    }

    // Claim ownership before yielding so queued results from an older batch
    // cannot arrive between the user's refresh action and listener readiness.
    try {
      if (listenersReadyRef.current) {
        await listenersReadyRef.current
      }
      // Tauri commands can execute concurrently. Register batches in the same
      // order that ownership was claimed so Rust and the UI agree on latest.
      await Promise.all(previousStartRequests)
      const result = await invoke<ProbeBatchStarted>("start_probe_batch", {
        batchId,
        pluginIds,
      })
      for (const batchMeta of batchMetaByProvider.values()) {
        batchMeta.previous = undefined
      }
      return result.pluginIds
    } catch (error) {
      activeBatchIds.current.delete(batchId)
      const failedPluginIds: string[] = []
      for (const [pluginId, batchMeta] of batchMetaByProvider) {
        batchMeta.failed = true
        if (options.invalidatePreviousOnFailure) {
          batchMeta.previous = undefined
        }
        if (latestBatchByProvider.current.get(pluginId) !== batchMeta) continue

        if (options.invalidatePreviousOnFailure) {
          latestBatchByProvider.current.delete(pluginId)
          failedPluginIds.push(pluginId)
          continue
        }

        let previousBatch = batchMeta.previous
        while (previousBatch?.failed) {
          previousBatch = previousBatch.previous
        }
        if (
          previousBatch &&
          !previousBatch.resultReceived &&
          activeBatchIds.current.has(previousBatch.batchId)
        ) {
          latestBatchByProvider.current.set(pluginId, previousBatch)
        } else {
          latestBatchByProvider.current.delete(pluginId)
          failedPluginIds.push(pluginId)
        }
      }
      throw new ProbeBatchStartError(error, failedPluginIds)
    } finally {
      releaseStartRequest()
      for (const pluginId of batchMetaByProvider.keys()) {
        if (startRequestTailByProvider.current.get(pluginId) === startRequest) {
          startRequestTailByProvider.current.delete(pluginId)
        }
      }
    }
  }, [])

  return { startBatch }
}
