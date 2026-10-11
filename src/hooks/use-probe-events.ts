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
  onResult?: (output: PluginOutput) => void
  onInterrupted?: (error: Error) => void
}

export type ProbeResultContext = {
  manual: boolean
}

export type StartBatchOptions = {
  manual?: boolean
  invalidatePreviousOnFailure?: boolean
  onResult?: (output: PluginOutput) => void
  onInterrupted?: (error: Error) => void
}

export type StartBatch = (
  pluginIds: string[],
  options?: StartBatchOptions
) => Promise<string[]>

export class ProbeVerificationCancelled extends Error {}

export class ProbeBatchStartError extends Error {
  readonly cause: unknown
  readonly pluginIds: string[]

  /** Retain the native failure and only the providers whose current check could not start. */
  constructor(cause: unknown, pluginIds: string[]) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = "ProbeBatchStartError"
    this.cause = cause
    this.pluginIds = pluginIds
  }
}

/** Limit error state updates to affected providers when the start failure carries ownership details. */
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

/** Deliver only each provider's latest check and cancel verification when its ownership changes. */
export function useProbeEvents({ onResult, onBatchComplete }: UseProbeEventsOptions) {
  const activeBatchIds = useRef<Set<string>>(new Set())
  const latestBatchByProvider = useRef<Map<string, ProbeBatchMeta>>(new Map())
  const startRequestTailByProvider = useRef<Map<string, Promise<void>>>(
    new Map()
  )
  const unlisteners = useRef<UnlistenFn[]>([])
  const listenersReadyRef = useRef<Promise<void> | null>(null)
  const listenersReadyResolveRef = useRef<(() => void) | null>(null)
  const listenersReadyRejectRef = useRef<((error: unknown) => void) | null>(null)

  useEffect(() => {
    let cancelled = false

    // Create the promise that will resolve when listeners are ready
    listenersReadyRef.current = new Promise<void>((resolve, reject) => {
      listenersReadyRejectRef.current = reject
      listenersReadyResolveRef.current = resolve
    })

    // Keep setup failures observable even if no probe has yet awaited readiness.
    void listenersReadyRef.current.catch(() => {})
    /** Install result and completion listeners before allowing a native batch to start. */
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
          latestBatch.onResult?.(event.payload.output)
        }
      })

      if (cancelled) {
        resultUnlisten()
        return
      }

      unlisteners.current.push(resultUnlisten)
      const completeUnlisten = await listen<ProbeBatchComplete>(
        "probe:batch-complete",
        (event) => {
          if (activeBatchIds.current.delete(event.payload.batchId)) {
            for (const batch of latestBatchByProvider.current.values()) {
              if (batch.batchId === event.payload.batchId && !batch.resultReceived) {
                batch.onInterrupted?.(new Error("检查未返回结果，请重新检查。"))
              }
            }
            onBatchComplete()
          }
        }
      )

      if (cancelled) {
        resultUnlisten()
        completeUnlisten()
        return
      }

      unlisteners.current.push(completeUnlisten)

      // Signal that listeners are ready
      listenersReadyResolveRef.current?.()
    }

    void setup().catch((error) => {
      console.error("Failed to initialize probe event listeners:", error)
      unlisteners.current.forEach((unlisten) => unlisten())
      unlisteners.current = []
      listenersReadyRejectRef.current?.(error)
    })

    return () => {
      cancelled = true
      for (const batch of latestBatchByProvider.current.values()) {
        batch.onInterrupted?.(new ProbeVerificationCancelled("连接检查已取消。"))
      }
      unlisteners.current.forEach((unlisten) => unlisten())
      unlisteners.current = []
      listenersReadyRef.current = null
      listenersReadyResolveRef.current = null
      listenersReadyRejectRef.current = null
    }
  }, [onBatchComplete, onResult])

  /** Claim ownership immediately, then serialize native starts for overlapping providers. */
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
      latestBatchByProvider.current.get(pluginId)?.onInterrupted?.(new ProbeVerificationCancelled("已开始新的检查，请等待新结果。"))
      const batchMeta: ProbeBatchMeta = {
        batchId,
        manual: options.manual === true,
        previous: latestBatchByProvider.current.get(pluginId),
        failed: false,
        resultReceived: false,
        onResult: options.onResult,
        onInterrupted: options.onInterrupted,
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
      if (options.onInterrupted && pluginIds.some((id) => !result.pluginIds.includes(id))) {
        options.onInterrupted(new Error("服务商不可用，无法检查连接。"))
      }
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

  /** Await one manual connection check, rejecting interruption, start failure, or a queue timeout. */
  const verifyPlugin = useCallback((pluginId: string) => new Promise<PluginOutput>((resolve, reject) => {
    // A native probe has a 30-second limit. Allow time for the four-worker queue.
    const timer = setTimeout(() => {
      console.error("Provider connection check timed out:", pluginId)
      reject(new Error("连接检查超时，请重试。"))
    }, 120_000)
    /** Release the verification timer before returning the current provider's result. */
    const finish = (output: PluginOutput) => { clearTimeout(timer); resolve(output) }
    /** Release the verification timer before propagating cancellation or native failure. */
    const interrupt = (error: Error) => { clearTimeout(timer); reject(error) }
    void startBatch([pluginId], { manual: true, onResult: finish, onInterrupted: interrupt }).catch(interrupt)
  }), [startBatch])

  return { startBatch, verifyPlugin }
}
