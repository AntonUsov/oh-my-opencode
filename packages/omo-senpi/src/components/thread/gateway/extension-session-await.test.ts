import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { awaitSessionRequest } from "./extension-session-await"
import type { StoreExtensionResult } from "./store-extensions"

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

const id = "tor_" + "e".repeat(32)
function wakeFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "session-await-"))
  directories.push(directory)
  mkdirSync(join(directory, "thread-open"))
  return join(directory, "thread-open", id)
}
const pending: StoreExtensionResult<unknown> = { kind: "ok", value: { status: "pending" } }
const refusedFinal: StoreExtensionResult<unknown> = { kind: "ok", value: { status: "refused" } }

test("#given a status call that throws once (the worker exited mid-call) #when the deadline passes #then the wait does not end on the throw: expire runs and the final status is returned", async () => {
  let statusCalls = 0
  let expired = false
  const result = await awaitSessionRequest({
    file: wakeFile(),
    timeoutMs: 50,
    status: async () => {
      statusCalls += 1
      if (statusCalls === 1) throw new Error("gateway store worker exited")
      return expired ? refusedFinal : pending
    },
    expire: async () => {
      expired = true
      return { kind: "ok", value: { expired: true } }
    },
  })
  expect(expired).toBe(true)
  expect(result).toEqual(refusedFinal)
})

test("#given an expire call that throws #when the deadline passes #then the answer is await_unresolved, never a raw error", async () => {
  const result = await awaitSessionRequest({
    file: wakeFile(),
    timeoutMs: 50,
    status: async () => pending,
    expire: async () => { throw new Error("gateway lock wait exceeded") },
  })
  expect(result).toMatchObject({ kind: "refused", code: "await_unresolved" })
})

test("#given no wake directory and a status call that throws #when the tool awaits #then it expires and answers from the final status instead of throwing", async () => {
  let expired = false
  const result = await awaitSessionRequest({
    file: join(tmpdir(), "session-await-absent", id),
    timeoutMs: 120_000,
    status: async () => {
      if (!expired) throw new Error("gateway store worker exited")
      return refusedFinal
    },
    expire: async () => {
      expired = true
      return { kind: "ok", value: { expired: true } }
    },
  })
  expect(result).toEqual(refusedFinal)
})
