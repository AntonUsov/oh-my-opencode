import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { gatewayDatabasePath } from "../gateway/paths"
import { GATEWAY_MIGRATIONS } from "../gateway/schema"
import { createGatewayStore, type GatewayStore } from "../gateway/store"
import type { StoreExtensionRegistration } from "../gateway/store-extensions"
import { createThreadTools, type ThreadHost, type ThreadHostSession } from "../tools"
import { buildExtensionTools } from "./extension-tools"

const directories: string[] = []
const stores: GatewayStore[] = []
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.dispose()))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const fixtureModule = new URL("../gateway/testing/session-callable-extension.mjs", import.meta.url)
const migrations = [[
  "CREATE TABLE gw_opens (id INTEGER PRIMARY KEY, args TEXT NOT NULL)",
  "CREATE TABLE gw_requests (id TEXT PRIMARY KEY, status TEXT NOT NULL)",
  "CREATE TABLE gw_items (binding_id TEXT PRIMARY KEY, status TEXT NOT NULL)",
]]
const registration = (moduleUrl: string): StoreExtensionRegistration => ({
  name: "gw",
  moduleUrl,
  migrations,
  wakeDir: "thread-open",
  sessionCallable: [{
    op: "openThread",
    toolName: "gw_open",
    description: "Open a chat thread for a session.",
    parameters: { type: "object", additionalProperties: false, required: ["target_session_durable_id"], properties: { target_session_durable_id: { type: "string" } } },
    targetArg: "target_session_durable_id",
  }],
})

function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

function storeAt(agentDir: string): GatewayStore {
  const store = createGatewayStore({ agentDir })
  stores.push(store)
  return store
}

function hostWith(sessions: ThreadHostSession[]): ThreadHost {
  const unused = async () => { throw new Error("not used by these tests") }
  return {
    socket: "/tmp/extension-tools-test.sock",
    listSessions: async () => sessions,
    openSession: async () => sessions[sessions.length - 1],
    getMessages: async () => [],
    getState: async () => ({ isStreaming: false }),
    prompt: unused, interrupt: unused, setSessionName: unused, setModel: unused,
    getAvailableModels: async () => [], setThinkingLevel: unused, getAvailableThinkingLevels: async () => [],
  } as ThreadHost
}

const caller = { sessionId: "route-caller", durableSessionId: "dur-caller", cwd: process.cwd(), name: "caller", status: "open" as const }
const ectxFor = (runtimeId: string) => ({ sessionManager: { getSessionId: () => runtimeId } })
const resultOf = (output: { details: { result: unknown } }) => output.details.result as { kind: string; code?: string; value?: { received?: Record<string, unknown> } }

async function surface(sessions: ThreadHostSession[], moduleUrl = fixtureModule.href) {
  const agentDir = tempDir("extension-tools-")
  const store = storeAt(agentDir)
  expect(await store.registerStoreExtension(registration(moduleUrl))).toMatchObject({ kind: "ok" })
  const host = hostWith(sessions)
  const tools = await buildExtensionTools({ host, store, stateDirectory: tempDir("extension-tools-state-"), callerSessionId: () => "UNKNOWN_CALLER", callerWorkspaceRoot: () => process.cwd() })
  return { agentDir, store, host, tools }
}

test("#given a persisted declaration #when a session builds its tools #then one tool per declared op exists under its toolName", async () => {
  const { tools } = await surface([caller])
  expect(tools.map((tool) => tool.name)).toEqual(["gw_open"])
})

test("#given an engine caller with a known runtime id #when the tool runs #then the op receives that caller's DURABLE id", async () => {
  const { tools } = await surface([caller])
  const output = await tools[0].execute("call-1", { target_session_durable_id: "dur-child" }, undefined, undefined, ectxFor("route-caller") as never)
  expect(resultOf(output)).toMatchObject({ kind: "ok", value: { received: { caller_session_durable_id: "dur-caller" } } })
})

test.each([
  ["no execution context (UNKNOWN_CALLER fallback)", undefined],
  ["a runtime id no address book entry knows", ectxFor("route-stranger")],
])("#given %s #when the tool runs #then it answers caller_context_missing and the op never runs", async (_label, ectx) => {
  const { tools } = await surface([caller])
  const output = await tools[0].execute("call-1", { target_session_durable_id: "dur-child" }, undefined, undefined, ectx as never)
  expect(resultOf(output)).toMatchObject({ code: "caller_context_missing" })
})

test("#given args that try to name the caller #when the tool runs #then it is refused before validation and the op never runs", async () => {
  const { tools } = await surface([caller])
  const output = await tools[0].execute("call-1", { target_session_durable_id: "dur-child", caller_session_durable_id: "dur-lead" }, undefined, undefined, ectxFor("route-caller") as never)
  expect(resultOf(output)).toMatchObject({ code: "invalid_arguments" })
})

test("#given a declaration whose module was deleted #when a session builds its tools #then building succeeds without importing it, and only the call fails extension_import_failed", async () => {
  const dir = tempDir("extension-tools-gone-")
  const gone = join(dir, "gone.mjs")
  writeFileSync(gone, await Bun.file(fixtureModule).text())
  const { tools } = await surface([caller], `file://${gone}`)
  rmSync(gone)
  expect(tools.map((tool) => tool.name)).toEqual(["gw_open"])
  const output = await tools[0].execute("call-1", { target_session_durable_id: "dur-child" }, undefined, undefined, ectxFor("route-caller") as never)
  expect(resultOf(output)).toMatchObject({ code: "extension_import_failed" })
})

test("#given the caller creates a child with thread_create #when it opens a thread for that child #then caller_created_target is stamped; for a peer it did not create, it is omitted", async () => {
  const child = { sessionId: "route-child", durableSessionId: "dur-child", cwd: process.cwd(), name: "child", status: "open" as const }
  const peer = { sessionId: "route-peer", durableSessionId: "dur-peer", cwd: process.cwd(), name: "peer", status: "open" as const }
  const sessions: ThreadHostSession[] = [caller, peer]
  const { store, host, tools } = await surface(sessions)
  const threadTools = createThreadTools({ host, store, stateDirectory: tempDir("extension-tools-create-"), callerSessionId: () => "UNKNOWN_CALLER", callerWorkspaceRoot: () => process.cwd() })
  sessions.push(child)
  const create = threadTools.find((tool) => tool.name === "thread_create")!
  expect(resultOf(await create.execute("call-c", { name: "new-child" }, undefined, undefined, ectxFor("route-caller") as never))).toMatchObject({ kind: "ok" })
  const own = resultOf(await tools[0].execute("call-1", { target_session_durable_id: "dur-child" }, undefined, undefined, ectxFor("route-caller") as never))
  expect(own.value?.received).toMatchObject({ caller_created_target: true })
  const other = resultOf(await tools[0].execute("call-2", { target_session_durable_id: "dur-peer" }, undefined, undefined, ectxFor("route-caller") as never))
  expect(Object.hasOwn(other.value?.received ?? {}, "caller_created_target")).toBe(false)
})

test("#given a store at the previous schema version with data #when it opens #then it migrates to the new tables and keeps every existing row", async () => {
  const agentDir = tempDir("extension-tools-migrate-")
  const path = gatewayDatabasePath(agentDir)
  const previous = GATEWAY_MIGRATIONS.length - 1
  {
    const seed = storeAt(agentDir)
    await seed.identity()
    await seed.dispose()
    stores.splice(stores.indexOf(seed), 1)
  }
  const db = new Database(path)
  try {
    db.exec("DROP TABLE IF EXISTS thread_creations; DROP TABLE IF EXISTS extension_registrations;")
    db.exec(`PRAGMA user_version = ${previous}`)
    db.query("INSERT INTO gateway_meta (key, value) VALUES ('fixture-keep', 'kept')").run()
  } finally { db.close() }
  const reopened = storeAt(agentDir)
  await reopened.identity()
  const check = new Database(path, { readonly: true })
  try {
    expect(check.query("SELECT value FROM gateway_meta WHERE key = 'fixture-keep'").get()).toEqual({ value: "kept" })
    const tables = check.query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('thread_creations', 'extension_registrations') ORDER BY name").all()
    expect(tables).toEqual([{ name: "extension_registrations" }, { name: "thread_creations" }])
  } finally { check.close() }
})
