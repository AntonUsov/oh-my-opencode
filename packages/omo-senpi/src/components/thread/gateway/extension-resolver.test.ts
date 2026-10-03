import { afterEach, beforeEach, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createExtensionResolver } from "./extension-resolver"

// The engine CLI the live surface enumerates endpoints through; it records each call and lists none.
let engineLog = ""
const dirs: string[] = []
const previousBin = process.env.SENPI_BIN
beforeEach(() => {
  const bin = mkdtempSync(join(tmpdir(), "ext-resolver-engine-"))
  dirs.push(bin)
  engineLog = join(bin, "calls.log")
  const engine = join(bin, "senpi")
  writeFileSync(engine, `#!/bin/sh\necho "$*" >> "${engineLog}"\necho '{"endpoints":[]}'\n`)
  chmodSync(engine, 0o755)
  process.env.SENPI_BIN = engine
})
afterEach(() => {
  if (previousBin === undefined) delete process.env.SENPI_BIN
  else process.env.SENPI_BIN = previousBin
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const engineCalls = () => (existsSync(engineLog) ? readFileSync(engineLog, "utf8").split("\n").filter(Boolean).length : 0)

function agentWithSession(durableId: string, name: string): string {
  const agentDir = mkdtempSync(join(tmpdir(), "ext-resolver-"))
  dirs.push(agentDir)
  const sessions = join(agentDir, "sessions", "--work--")
  mkdirSync(sessions, { recursive: true })
  writeFileSync(join(sessions, `2026-10-03_${durableId}.jsonl`), [
    JSON.stringify({ type: "session", version: 3, id: durableId, timestamp: "2026-10-03T00:00:00.000Z", cwd: agentDir }),
    JSON.stringify({ type: "session_info", name }),
  ].join("\n") + "\n")
  return agentDir
}

test("#given a target addressed by its durable id with a session file #when an extension resolves it #then the engine is not asked to enumerate live endpoints", async () => {
  const resolve = createExtensionResolver(agentWithSession("dur-target", "target"))

  const resolved = await resolve("dur-target", { all_scope: true })

  expect(resolved).toMatchObject({ kind: "ok", target: { durable_id: "dur-target" } })
  expect(engineCalls()).toBe(0)
})

test("#given a target addressed by name #when an extension resolves it #then live endpoints are still enumerated", async () => {
  const resolve = createExtensionResolver(agentWithSession("dur-named", "named-thread"))

  await resolve("named-thread", { all_scope: true })

  expect(engineCalls()).toBeGreaterThan(0)
})
