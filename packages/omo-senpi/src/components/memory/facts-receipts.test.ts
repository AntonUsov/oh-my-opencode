import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  FactsFailureStore,
  buildIdentityPaths,
  readMemoryReceipts,
  type MemoryIdentityPaths,
  type MemoryReceiptInput,
} from "@oh-my-opencode/memory-core"

import { FactsTerminalWrites } from "./facts-terminal-writes"
import { reserveFactsRunDir } from "./facts-run-storage"
import type { MemoryReceiptsPort } from "./receipts-port"
import { writeRunJsonAtomic } from "./worker/run-artifacts"

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

const NOW = new Date("2026-08-11T10:00:00.000Z")
const target = { conversationId: "conversation-a", endMessageId: "m-9", endSnapshotLine: 9 }

async function factsRun(): Promise<{ paths: MemoryIdentityPaths; runDir: string; batchId: string }> {
  const root = await mkdtemp(join(tmpdir(), "facts-receipts-"))
  roots.push(root)
  const paths = buildIdentityPaths(root, "agent-test")
  const batchId = "batch-0001"
  const runDir = join(paths.facts, "runs", "facts-abc-1")
  await mkdir(runDir, { recursive: true })
  await writeRunJsonAtomic(join(runDir, "ledger.json"), {
    version: 1, runId: "facts-abc-1", kind: "facts", startedAt: NOW.toISOString(),
    hardDeadlineAt: 1, terminationGraceMs: 1, deadlineAt: 2, batchId, queued: [],
  })
  return { paths, runDir, batchId }
}

function writes(paths: MemoryIdentityPaths, receipts?: MemoryReceiptsPort): FactsTerminalWrites {
  return new FactsTerminalWrites({
    failures: new FactsFailureStore({ identityPaths: paths, now: () => NOW }),
    now: () => NOW,
    markConsumed: async () => undefined,
    receiptsDir: paths.runtime,
    ...(receipts === undefined ? {} : { receipts }),
  })
}

async function read(paths: MemoryIdentityPaths) {
  return [...(await readMemoryReceipts(paths.runtime, { kind: "facts" })).receipts].reverse()
}

describe("facts receipts", () => {
  test("#given a committed batch #when it succeeds #then one committed receipt carries the batch id and sha", async () => {
    // given
    const { paths, runDir, batchId } = await factsRun()

    // when
    await writes(paths).succeed(runDir, "facts-abc-1", "committed", { entries: [], targets: [] }, "f00d")

    // then
    expect(await read(paths)).toMatchObject([{ kind: "facts", batchId, event: "committed", sha: "f00d" }])
  })

  test("#given an empty extraction #when it succeeds #then the receipt says no_facts", async () => {
    // given
    const { paths, runDir } = await factsRun()

    // when
    await writes(paths).succeed(runDir, "facts-abc-1", "no_facts", { entries: [], targets: [] })

    // then
    expect((await read(paths)).map((receipt) => receipt.event)).toEqual(["no_facts"])
  })

  test("#given a failure that parks its endpoint #when recorded #then failed and parked receipts follow the sentinel", async () => {
    // given
    const { paths, runDir, batchId } = await factsRun()
    const order: Array<{ readonly event: string; readonly sentinel: boolean }> = []
    const port: MemoryReceiptsPort = {
      append: async (runtimeDir: string, input: MemoryReceiptInput) => {
        order.push({ event: input.event, sentinel: existsSync(join(runDir, "final.json")) })
        const { appendMemoryReceiptOnce } = await import("@oh-my-opencode/memory-core")
        return appendMemoryReceiptOnce(runtimeDir, input)
      },
    }

    // when
    await writes(paths, port).fail({ runDir, runId: "facts-abc-1", batchId, targets: [target], reason: "secret_like_content", detail: "refused" })

    // then
    expect(order).toEqual([{ event: "failed", sentinel: true }, { event: "parked", sentinel: true }])
    expect(await read(paths)).toMatchObject([
      { batchId, event: "failed", reason: "secret_like_content" },
      { batchId, event: "parked", reason: "secret_like_content" },
    ])
  })

  test("#given a failure that only backs off #when recorded #then failed is receipted and parked is not", async () => {
    // given
    const { paths, runDir, batchId } = await factsRun()

    // when
    await writes(paths).fail({ runDir, runId: "facts-abc-1", batchId, targets: [target], reason: "child_exit", detail: "exit 1" })

    // then
    expect((await read(paths)).map((receipt) => receipt.event)).toEqual(["failed"])
  })

  test("#given a run reconciliation cannot prove dead #when abandoned #then an abandoned receipt follows abandoned.json", async () => {
    // given
    const { paths, runDir, batchId } = await factsRun()
    const ledger = { version: 1 as const, runId: "facts-abc-1", kind: "facts" as const, startedAt: NOW.toISOString(), hardDeadlineAt: 1, terminationGraceMs: 1, deadlineAt: 2, batchId, queued: [] }

    // when
    await writes(paths).abandon(runDir, ledger, "unknown_liveness")

    // then
    expect(existsSync(join(runDir, "abandoned.json"))).toBe(true)
    expect(await read(paths)).toMatchObject([{ batchId, event: "abandoned", reason: "unknown_liveness" }])
  })

  test("#given a receipt write that fails #when the batch succeeds #then the run still finishes and final.json lands", async () => {
    // given
    const { paths, runDir } = await factsRun()
    const broken: MemoryReceiptsPort = { append: async () => { throw new Error("disk full") } }

    // when
    await writes(paths, broken).succeed(runDir, "facts-abc-1", "committed", { entries: [], targets: [] }, "f00d")

    // then
    expect(existsSync(join(runDir, "final.json"))).toBe(true)
    expect(await read(paths)).toEqual([])
  })

  test("#given a facts batch reserved for launch #when its run dir is claimed #then a launched receipt carries its batch id", async () => {
    // given
    const root = await mkdtemp(join(tmpdir(), "facts-receipts-launch-"))
    roots.push(root)
    const paths = buildIdentityPaths(root, "agent-test")

    // when
    const runDir = await reserveFactsRunDir({
      factsDir: paths.facts,
      locksDir: paths.locks,
      entries: [],
      batchId: "batch-launch",
      launchedAt: NOW.getTime(),
      receiptsDir: paths.runtime,
    })

    // then
    expect(runDir).toBeDefined()
    expect(await read(paths)).toMatchObject([{ kind: "facts", batchId: "batch-launch", event: "launched" }])
  })
})
