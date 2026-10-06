import { existsSync } from "node:fs"

import { GitMemoryRepo } from "@oh-my-opencode/memory-core"

import type { MemoryIdentityContext } from "./context"

/** Logger surface the scheduler needs. */
export interface MemoryMaintenanceLogger {
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
}

export interface MemoryMaintenanceOptions {
  readonly logger?: MemoryMaintenanceLogger
  readonly createRepo?: (context: MemoryIdentityContext) => GitMemoryRepo
  /** Wait after a session binds, so maintenance never competes with startup or the first prompt. */
  readonly delayMs?: number
  /** At most one run per identity in this interval, across every session and process. */
  readonly intervalMs?: number
  readonly minLooseObjects?: number
  readonly timeoutMs?: number
  readonly now?: () => number
}

export interface MemoryMaintenance {
  /** Schedules one background pass for this identity; repeated calls in this process are no-ops. */
  schedule(context: MemoryIdentityContext): void
  /** Cancels a pass that has not started yet. */
  dispose(): void
  /** Resolves once every scheduled pass has run (or failed, or been disposed). */
  settled(): Promise<void>
}

const STAMP_KEY = "omo.maintenanceAt"
const DEFAULT_DELAY_MS = 30_000
const DEFAULT_INTERVAL_MS = 12 * 60 * 60 * 1000
// git's own gc.auto default is 6,700; packing earlier keeps history walks fast on slower disks.
const DEFAULT_MIN_LOOSE_OBJECTS = 2_000
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Keeps the memory repo packed off the hot path (#9667). Commits set `gc.auto=0` so no commit waits on
 * a repack; this background pass is what packs the loose objects instead. It runs after a delay, at most
 * once per interval per identity (the stamp lives in the repo's own config, so every session and process
 * shares it), and only when there are enough loose objects to matter. Failures are logged, never raised.
 */
export function createMemoryMaintenance(options: MemoryMaintenanceOptions = {}): MemoryMaintenance {
  const createRepo = options.createRepo
    ?? ((context: MemoryIdentityContext) => new GitMemoryRepo({ dir: context.identityPaths.repo, agentId: context.identity }))
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const minLooseObjects = options.minLooseObjects ?? DEFAULT_MIN_LOOSE_OBJECTS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const now = options.now ?? Date.now
  const scheduled = new Set<string>()
  const timers = new Map<ReturnType<typeof setTimeout>, () => void>()
  const running = new Set<Promise<void>>()

  async function run(context: MemoryIdentityContext): Promise<void> {
    // A transient identity has no repo until it is promoted.
    if (!existsSync(context.identityPaths.repo)) return
    const repo = createRepo(context)
    const last = Number(await repo.configGet(STAMP_KEY) ?? Number.NaN)
    if (Number.isFinite(last) && now() - last < intervalMs) return
    // Claim the interval before the run, so a second session starting meanwhile skips it; git's own
    // maintenance lock is the backstop if two still overlap.
    await repo.configSet(STAMP_KEY, String(now()))
    const result = await repo.maintain({ minLooseObjects, timeoutMs })
    if (result.status === "packed") {
      options.logger?.info("omo-senpi memory repo packed", {
        identity: context.identity,
        looseObjectsBefore: result.looseObjectsBefore,
        looseObjectsAfter: result.looseObjectsAfter,
      })
    }
  }

  return {
    schedule(context): void {
      if (scheduled.has(context.identity)) return
      scheduled.add(context.identity)
      let finish = (): void => {}
      const pass = new Promise<void>((resolve) => {
        finish = resolve
      }).finally(() => running.delete(pass))
      running.add(pass)
      const timer = setTimeout(() => {
        timers.delete(timer)
        void run(context).catch((error: unknown) => {
          options.logger?.warn("omo-senpi memory repo maintenance failed", {
            identity: context.identity,
            error: error instanceof Error ? error.message : String(error),
          })
        }).finally(finish)
      }, delayMs)
      // A short-lived process (a print run, a test) exits without waiting for it.
      timer.unref?.()
      timers.set(timer, finish)
    },
    dispose(): void {
      for (const [timer, finish] of timers) {
        clearTimeout(timer)
        finish()
      }
      timers.clear()
    },
    async settled(): Promise<void> {
      await Promise.all([...running])
    },
  }
}
