import { watch, type FSWatcher } from "node:fs"
import { basename, dirname } from "node:path"

import type { StoreExtensionResult } from "./store-extensions"

export type SessionAwait = {
  /** `<dirname(store file)>/<wakeDir>/<await_request_id>`: the connector touches it after its completion commits. */
  readonly file: string
  readonly timeoutMs: number
  readonly status: () => Promise<StoreExtensionResult<unknown>>
  readonly expire: () => Promise<StoreExtensionResult<unknown>>
}

/** A status is final unless it says `pending`; a refused status call is final too. */
function settled(result: StoreExtensionResult<unknown>): boolean {
  if (result.kind !== "ok") return true
  const value = result.value
  return !(typeof value === "object" && value !== null && (value as { readonly status?: unknown }).status === "pending")
}

/**
 * Waits for a session op's await without polling. The watch on the wake file and its directory is
 * armed FIRST, then `status` runs once (a completion that landed before the watch is caught here),
 * then every wake re-checks `status`. At `timeoutMs`, `expire` runs and then `status` once more, so an
 * open that completes during the expiry still returns as opened. A missing directory (the connector
 * is not running) or a dropped event costs at most `timeoutMs`, never correctness.
 */
export async function awaitSessionRequest(request: SessionAwait): Promise<StoreExtensionResult<unknown>> {
  let woken = false
  let wake: (() => void) | undefined
  const signal = (): void => {
    woken = true
    wake?.()
  }
  const name = basename(request.file)
  const watchers: FSWatcher[] = []
  for (const [path, only] of [[dirname(request.file), name], [request.file, undefined]] as const) {
    try {
      const watcher = watch(path, (_event, filename) => {
        if (only === undefined || filename === null || String(filename) === only) signal()
      })
      watcher.on("error", () => undefined)
      watchers.push(watcher)
    } catch {
      // Not there yet: the other watch, or the deadline, covers it.
    }
  }
  const deadline = Date.now() + request.timeoutMs
  try {
    for (;;) {
      woken = false
      const current = await request.status()
      if (settled(current)) return current
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      if (woken) continue
      const arrived = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), remaining)
        wake = () => {
          clearTimeout(timer)
          resolve(true)
        }
      })
      wake = undefined
      if (!arrived) break
    }
    await request.expire()
    return await request.status()
  } finally {
    for (const watcher of watchers) watcher.close()
  }
}
