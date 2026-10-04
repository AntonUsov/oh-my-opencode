import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { createGatewayRelay } from "./relay"
import { gatewayDatabasePath } from "./paths"
import type { GatewayStore } from "./store"
import type { SessionCallableOp, StoreExtensionRegistration } from "./store-extensions"
import { createGatewayHarness, type GatewayHarness } from "./testing/harness"

let harness: GatewayHarness | undefined
afterEach(async () => { await harness?.dispose(); harness = undefined })

const moduleUrl = new URL("./testing/session-callable-extension.mjs", import.meta.url).href
const migrations = [[
  "CREATE TABLE gw_opens (id INTEGER PRIMARY KEY, args TEXT NOT NULL)",
  "CREATE TABLE gw_requests (id TEXT PRIMARY KEY, status TEXT NOT NULL)",
  "CREATE TABLE gw_items (binding_id TEXT PRIMARY KEY, status TEXT NOT NULL)",
  "CREATE TABLE gw_leads (item TEXT PRIMARY KEY, lead TEXT NOT NULL)",
]]
const openOp: SessionCallableOp = {
  op: "openThread",
  toolName: "open",
  description: "Open a chat thread for a session.",
  parameters: { type: "object", additionalProperties: false, required: ["target_session_durable_id"], properties: { target_session_durable_id: { type: "string" }, await: { type: "boolean" }, await_request_id: { type: "string" } } },
  targetArg: "target_session_durable_id",
  await: { statusOp: "threadOpenStatus", expireOp: "expireThreadOpen", timeoutMs: 2_000 },
  wake: "requests.marker",
}
const statusOp: SessionCallableOp = {
  op: "workItemStatus",
  toolName: "work_item_status",
  description: "Report the status of the caller's own work item.",
  parameters: { type: "object", additionalProperties: false, required: ["status"], properties: { status: { type: "string", enum: ["working", "waiting", "done", "failed"] }, note: { type: "string", maxLength: 500 }, work_item_id: { type: "string" } } },
  wake: "requests.marker",
}
const registration = (overrides: Partial<StoreExtensionRegistration> = {}): StoreExtensionRegistration => ({
  name: "gw", moduleUrl, migrations, wakeDir: "thread-open", sessionCallable: [openOp, statusOp], ...overrides,
})
const bindTo = (store: GatewayStore, h: GatewayHarness, session: string, chat: string) =>
  createGatewayRelay({ store, engine: h.engineFor(store), endpoints: { wake: async () => ({ admitted: [] }) }, locate: async () => null, now: () => h.clock.now })
    .bind({ principal: `session:${session}`, binding: { platform: "custom", account_id: "qa", chat_id: chat, thread_id: "t1", session_durable_id: session } })

test.each<[string, Partial<SessionCallableOp>]>([
  ["an op the module does not export", { op: "missingOp" }],
  ["a toolName past the 41-character short-name bound", { toolName: "t".repeat(42) }],
  ["a one-character toolName", { toolName: "x" }],
  ["a toolName with uppercase", { toolName: "GwOpen" }],
  ["parameters without additionalProperties:false", { parameters: { type: "object", properties: { target_session_durable_id: { type: "string" } } } }],
  ["a targetArg absent from parameters", { targetArg: "session" }],
  ["a timeoutMs out of range", { await: { statusOp: "threadOpenStatus", expireOp: "expireThreadOpen", timeoutMs: 0 } }],
  ["an await statusOp the module does not export", { await: { statusOp: "nope", expireOp: "expireThreadOpen", timeoutMs: 2_000 } }],
  ["a wake name with a slash", { wake: "../escape" }],
])("#given a declaration with %s #when registering #then it is refused and nothing is persisted", async (_label, broken) => {
  const h = (harness = createGatewayHarness())
  const store = h.store()
  expect(await store.registerStoreExtension(registration({ sessionCallable: [{ ...openOp, ...broken }] }))).toMatchObject({ kind: "refused" })
  expect(await store.sessionCallableOps()).toEqual([])
})

test.each(["../escape", "Thread-Open", ""])("#given wakeDir %p #when registering #then it is refused", async (wakeDir) => {
  const h = (harness = createGatewayHarness())
  expect(await h.store().registerStoreExtension(registration({ wakeDir }))).toMatchObject({ kind: "refused" })
})

test("#given the gateway's registration (omo_gateway: thread_open, work_item_status) #when another process lists session ops #then the tools are exactly ext_omo_gateway_thread_open and ext_omo_gateway_work_item_status", async () => {
  const h = (harness = createGatewayHarness())
  const gateway = registration({ name: "omo_gateway", migrations: [], sessionCallable: [{ ...openOp, toolName: "thread_open" }, { ...statusOp, toolName: "work_item_status" }] })
  expect(await h.store().registerStoreExtension(gateway)).toMatchObject({ kind: "ok" })
  expect((await h.store().sessionCallableOps()).map((entry) => entry.registeredName)).toEqual(["ext_omo_gateway_thread_open", "ext_omo_gateway_work_item_status"])
})

test("#given a toolName whose composed ext_<extension>_<toolName> passes 64 characters #when registering #then it is refused and nothing is persisted", async () => {
  const h = (harness = createGatewayHarness())
  const store = h.store()
  expect(await store.registerStoreExtension(registration({ name: "x".repeat(32), migrations: [], sessionCallable: [{ ...statusOp, toolName: "t".repeat(30) }] }))).toMatchObject({ kind: "refused", code: "invalid_arguments" })
  expect(await store.sessionCallableOps()).toEqual([])
})

test("#given two extensions whose composed tool names are equal (ab + cc_dd, ab_cc + dd) #when the second registers #then it is refused and the first keeps the name", async () => {
  const h = (harness = createGatewayHarness())
  const store = h.store()
  expect(await store.registerStoreExtension(registration({ name: "ab", migrations: [], sessionCallable: [{ ...statusOp, toolName: "cc_dd" }] }))).toMatchObject({ kind: "ok" })
  expect(await store.registerStoreExtension(registration({ name: "ab_cc", migrations: [], sessionCallable: [{ ...statusOp, toolName: "dd" }] }))).toMatchObject({ kind: "refused", code: "invalid_arguments" })
  expect((await h.store().sessionCallableOps()).map((entry) => [entry.extension, entry.registeredName])).toEqual([["ab", "ext_ab_cc_dd"]])
})

test("#given two declared ops #when another process lists session ops #then it sees exactly both, and each is refused on the public channel", async () => {
  const h = (harness = createGatewayHarness())
  await h.store().registerStoreExtension(registration())
  const other = h.store()
  const ops = await other.sessionCallableOps()
  expect(ops.map((entry) => entry.registeredName).sort()).toEqual(["ext_gw_open", "ext_gw_work_item_status"])
  for (const op of ["openThread", "workItemStatus"]) expect(await other.extensionCall("gw", op, {})).toMatchObject({ kind: "refused", code: "caller_not_allowed" })
})

test("#given a declaration persisted by one process #when a second process calls the op through the session channel #then its worker imports the module and runs it", async () => {
  const h = (harness = createGatewayHarness())
  await h.store().registerStoreExtension(registration())
  const second = h.store()
  const result = await second.extensionSessionCall("gw", "openThread", { target_session_durable_id: "child" }, { callerDurableId: "caller" })
  expect(result).toMatchObject({ kind: "ok", value: { opened: true } })
})

test("#given an extension registered only by another process #when this process makes a PUBLIC extensionCall to one of its ordinary ops #then its worker imports the module from the persisted row and runs the op", async () => {
  const h = (harness = createGatewayHarness())
  await h.store().registerStoreExtension(registration())
  const connector = h.store()
  const id = "tor_" + "9".repeat(32)
  expect(await connector.extensionCall("gw", "completeThreadOpen", { await_request_id: id })).toMatchObject({ kind: "ok", value: { completed: true } })
  expect(await connector.extensionCall("gw", "openThread", { target_session_durable_id: "child" })).toMatchObject({ kind: "refused", code: "caller_not_allowed" })
})

test("#given a persisted moduleUrl that no longer exists #when a session lists ops and then calls one #then listing works without importing, and the call alone answers extension_import_failed", async () => {
  const h = (harness = createGatewayHarness())
  const gone = join(h.agentDir, "gone-extension.mjs")
  writeFileSync(gone, (await Bun.file(new URL(moduleUrl)).text()))
  await h.store().registerStoreExtension(registration({ moduleUrl: `file://${gone}` }))
  Bun.spawnSync(["rm", "-f", gone])
  const session = h.store()
  expect((await session.sessionCallableOps()).map((entry) => entry.registeredName).sort()).toEqual(["ext_gw_open", "ext_gw_work_item_status"])
  expect(await session.extensionSessionCall("gw", "openThread", { target_session_durable_id: "child" }, { callerDurableId: "caller" })).toMatchObject({ kind: "refused", code: "extension_import_failed" })
  writeFileSync(gone, (await Bun.file(new URL(moduleUrl)).text()))
  expect(await session.extensionSessionCall("gw", "openThread", { target_session_durable_id: "child" }, { callerDurableId: "caller" })).toMatchObject({ kind: "ok" })
})

test("#given a persisted moduleUrl that is not a file .js/.mjs/.cjs URL #when the session channel would load it #then it is refused", async () => {
  const h = (harness = createGatewayHarness())
  await h.store().registerStoreExtension(registration())
  const db = new (await import("bun:sqlite")).Database(gatewayDatabasePath(h.agentDir))
  try { db.query("UPDATE extension_registrations SET descriptor_json = json_set(descriptor_json, '$.moduleUrl', 'https://example.invalid/x.mjs') WHERE name = 'gw'").run() } finally { db.close() }
  expect(await h.store().extensionSessionCall("gw", "openThread", { target_session_durable_id: "child" }, { callerDurableId: "caller" })).toMatchObject({ kind: "refused" })
})

test("#given the same extension registered again from a second location #when listing #then exactly one descriptor exists and the new module is called", async () => {
  const h = (harness = createGatewayHarness())
  const relocated = join(h.agentDir, "relocated", "session-callable-extension.mjs")
  mkdirSync(dirname(relocated), { recursive: true })
  writeFileSync(relocated, (await Bun.file(new URL(moduleUrl)).text()).replace("opened: true", "opened: true, relocated: true"))
  await h.store().registerStoreExtension(registration())
  await h.store().registerStoreExtension(registration({ moduleUrl: `file://${relocated}` }))
  const later = h.store()
  expect(await later.sessionCallableOps()).toHaveLength(2)
  expect(await later.extensionSessionCall("gw", "openThread", { target_session_durable_id: "child" }, { callerDurableId: "caller" })).toMatchObject({ kind: "ok", value: { relocated: true } })
})

test("#given no extension declarations #when a session lists ops #then the answer is empty and no extension module is imported", async () => {
  const h = (harness = createGatewayHarness())
  expect(await h.store().sessionCallableOps()).toEqual([])
})

test("#given a session bound with the core bind #when an op reads bindingsForSession in its transaction #then that binding is returned; another session gets none", async () => {
  const h = (harness = createGatewayHarness())
  const store = h.store()
  await store.registerStoreExtension(registration())
  expect(await bindTo(store, h, "bound", "chat-a")).toMatchObject({ kind: "ok" })
  const bound = await store.extensionSessionCall("gw", "workItemStatus", { status: "working" }, { callerDurableId: "bound" })
  expect(bound).toMatchObject({ kind: "ok", value: { updated: true } })
  expect(await store.extensionSessionCall("gw", "workItemStatus", { status: "working" }, { callerDurableId: "loose" })).toMatchObject({ kind: "ok", value: { updated: false, reason: "no_binding" } })
})

test("#given a binding that expired #when bindingsForSession runs #then it is not returned", async () => {
  const h = (harness = createGatewayHarness())
  const store = h.store()
  await store.registerStoreExtension(registration())
  await bindTo(store, h, "bound", "chat-a")
  h.clock.now += 400 * 24 * 60 * 60 * 1000
  expect(await store.extensionSessionCall("gw", "workItemStatus", { status: "working" }, { callerDurableId: "bound" })).toMatchObject({ kind: "ok", value: { updated: false, reason: "no_binding" } })
})

test("#given a worker bound to item A #when it names item B whose lead is another session #then the op refuses it, because the caller it sees is the engine's and cannot be the lead's", async () => {
  const h = (harness = createGatewayHarness())
  const store = h.store()
  await store.registerStoreExtension(registration())
  await bindTo(store, h, "worker-a", "chat-a")
  await store.extensionCall("gw", "sql", { sql: "INSERT INTO gw_leads (item, lead) VALUES ('item-b', 'lead-b')" })
  const named = await store.extensionSessionCall("gw", "workItemStatus", { status: "done", work_item_id: "item-b" }, { callerDurableId: "worker-a" })
  expect(named).toMatchObject({ kind: "ok", value: { updated: false, reason: "not_item_lead" } })
  const asLead = await store.extensionSessionCall("gw", "workItemStatus", { status: "done", work_item_id: "item-b", caller_session_durable_id: "lead-b" }, { callerDurableId: "worker-a" })
  expect(asLead).toMatchObject({ kind: "refused", code: "invalid_arguments" })
  const own = await store.extensionSessionCall("gw", "workItemStatus", { status: "done" }, { callerDurableId: "worker-a" })
  expect(own).toMatchObject({ kind: "ok", value: { updated: true } })
  expect((own as { value: { binding_id: string } }).value.binding_id).not.toBe("item-b")
})

test("#given the item's lead #when it names that item #then the op accepts it", async () => {
  const h = (harness = createGatewayHarness())
  const store = h.store()
  await store.registerStoreExtension(registration())
  await store.extensionCall("gw", "sql", { sql: "INSERT INTO gw_leads (item, lead) VALUES ('item-b', 'lead-b')" })
  expect(await store.extensionSessionCall("gw", "workItemStatus", { status: "failed", work_item_id: "item-b" }, { callerDurableId: "lead-b" })).toMatchObject({ kind: "ok", value: { updated: true, binding_id: "item-b" } })
})

test("#given a declared wake file #when a session call commits #then the marker is touched after the commit; a refused call and a rolled-back call do not touch it", async () => {
  const h = (harness = createGatewayHarness())
  const store = h.store()
  await store.registerStoreExtension(registration({ sessionCallable: [openOp, { ...statusOp, op: "failAfterWrite", toolName: "fail", wake: "requests.marker" }] }))
  const marker = join(dirname(gatewayDatabasePath(h.agentDir)), "thread-open", "requests.marker")
  mkdirSync(dirname(marker), { recursive: true })
  expect(await store.extensionSessionCall("gw", "openThread", { target_session_durable_id: "child", nope: 1 }, { callerDurableId: "caller" })).toMatchObject({ kind: "refused" })
  expect(existsSync(marker)).toBe(false)
  expect(await store.extensionSessionCall("gw", "failAfterWrite", { status: "working" }, { callerDurableId: "caller" })).toMatchObject({ kind: "refused" })
  expect(existsSync(marker)).toBe(false)
  expect(await store.extensionSessionCall("gw", "openThread", { target_session_durable_id: "child" }, { callerDurableId: "caller" })).toMatchObject({ kind: "ok" })
  expect(statSync(marker).isFile()).toBe(true)
})

test.each(["tor_short", "../../escape", "tor_" + "G".repeat(32)])("#given an await_request_id %p #when the tool would wait on it #then it is refused before any path is built", async (awaitId) => {
  const h = (harness = createGatewayHarness())
  const store = h.store()
  await store.registerStoreExtension(registration())
  expect(await store.extensionSessionAwait("gw", "openThread", { target_session_durable_id: "child", await: true, await_request_id: awaitId }, { callerDurableId: "caller" })).toMatchObject({ kind: "refused", code: "invalid_arguments" })
})

test("#given the connector completes before the wait is armed #when the tool awaits #then it returns the final status at once, without waiting for the timeout", async () => {
  const h = (harness = createGatewayHarness())
  const store = h.store()
  await store.registerStoreExtension(registration({ sessionCallable: [{ ...openOp, await: { ...openOp.await!, timeoutMs: 120_000 } }] }))
  const id = "tor_" + "1".repeat(32)
  await store.extensionCall("gw", "completeThreadOpen", { await_request_id: id })
  const result = await store.extensionSessionAwait("gw", "openThread", { target_session_durable_id: "child", await: true, await_request_id: id }, { callerDurableId: "caller" })
  expect(result).toMatchObject({ kind: "ok", value: { status: "opened" } })
})

test("#given a waiter that read pending and armed its watch #when a SEPARATE store completes the open and touches the wake file #then the watch wakes the waiter, which returns opened long before its 120 s timeout", async () => {
  const h = (harness = createGatewayHarness())
  const armedIds: string[] = []
  let armed: () => void = () => undefined
  const waiterArmed = new Promise<void>((resolve) => { armed = resolve })
  // The hook fires only after the first status read answered pending, so the completion below lands after it.
  const store = h.store({ _test: { onAwaitArmed: (id) => { armedIds.push(id); armed() } } })
  await store.registerStoreExtension(registration({ sessionCallable: [{ ...openOp, await: { ...openOp.await!, timeoutMs: 120_000 } }] }))
  const id = "tor_" + "2".repeat(32)
  const wake = join(dirname(gatewayDatabasePath(h.agentDir)), "thread-open", id)
  mkdirSync(dirname(wake), { recursive: true })
  const waiting = store.extensionSessionAwait("gw", "openThread", { target_session_durable_id: "child", await: true, await_request_id: id }, { callerDurableId: "caller" })
  await waiterArmed
  const connector = h.store()
  expect(await connector.extensionCall("gw", "completeThreadOpen", { await_request_id: id })).toMatchObject({ kind: "ok" })
  writeFileSync(wake, "")
  expect(await waiting).toMatchObject({ kind: "ok", value: { status: "opened" } })
  expect(armedIds).toEqual([id])
}, 15_000)

test("#given a running connector (wake dir present) but no wake ever arrives #when timeoutMs passes #then expireOp runs and the final status is returned", async () => {
  const h = (harness = createGatewayHarness())
  const store = h.store()
  await store.registerStoreExtension(registration({ sessionCallable: [{ ...openOp, await: { ...openOp.await!, timeoutMs: 50 } }] }))
  mkdirSync(join(dirname(gatewayDatabasePath(h.agentDir)), "thread-open"), { recursive: true })
  const id = "tor_" + "3".repeat(32)
  const result = await store.extensionSessionAwait("gw", "openThread", { target_session_durable_id: "child", await: true, await_request_id: id }, { callerDurableId: "caller" })
  expect(result).toMatchObject({ kind: "ok", value: { status: "refused" } })
})

test("#given no connector has started (no wake dir) #when the tool awaits with a long timeout #then it expires at once instead of waiting it out", async () => {
  const h = (harness = createGatewayHarness())
  const store = h.store()
  await store.registerStoreExtension(registration({ sessionCallable: [{ ...openOp, await: { ...openOp.await!, timeoutMs: 120_000 } }] }))
  const id = "tor_" + "4".repeat(32)
  const result = await store.extensionSessionAwait("gw", "openThread", { target_session_durable_id: "child", await: true, await_request_id: id }, { callerDurableId: "caller" })
  expect(result).toMatchObject({ kind: "ok", value: { status: "refused" } })
})
