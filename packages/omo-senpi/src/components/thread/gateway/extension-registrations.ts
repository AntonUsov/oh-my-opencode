/**
 * The persisted half of store extension registrations (`extension_registrations`, schema v10): the
 * descriptor `register()` upserts by name, the session-op declaration rules both `register()` and
 * every reader apply, and the worker's lazy import of a persisted module. An engine process lists
 * session tools from these rows without importing anything; only a call imports the module.
 */
import { existsSync } from "node:fs"
import { extname } from "node:path"
import { fileURLToPath } from "node:url"

import type { StoreContext } from "./store-ops"
import type { DeclaredSessionOp, SessionCallableOp, StoreExtensionRegistration } from "./store-extensions"

export const RESERVED_CALLER_KEYS = ["caller_session_durable_id", "caller_created_target"] as const
export const AWAIT_REQUEST_ID = /^tor_[a-f0-9]{32}$/
export const AWAIT_TIMEOUT_MAX_MS = 120_000
const TOOL_NAME = /^[a-z][a-z0-9_]{2,63}$/
const WAKE_DIR = /^[a-z0-9][a-z0-9_-]*$/
const WAKE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** What a registration persists: everything a process that never registered it needs to call it. */
export type PersistedDescriptor = Pick<StoreExtensionRegistration, "moduleUrl" | "migrations" | "sessionCallable" | "wakeDir">

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value)
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0

function entryProblem(entry: unknown, wakeDir: string | undefined): string | undefined {
  if (!isRecord(entry)) return "a sessionCallable entry must be an object"
  const { op, toolName, description, parameters, targetArg, wake } = entry
  const awaited = entry.await
  if (!nonEmpty(op)) return "op must be a non-empty string"
  if (typeof toolName !== "string" || !TOOL_NAME.test(toolName) || toolName.startsWith("thread_")) return `toolName ${String(toolName)} must match ${TOOL_NAME.source} outside the thread_ family`
  if (!nonEmpty(description)) return `${toolName}: description must be a non-empty string`
  if (!isRecord(parameters) || parameters.type !== "object" || parameters.additionalProperties !== false) return `${toolName}: parameters must be an object schema with additionalProperties: false`
  const properties = parameters.properties ?? {}
  if (!isRecord(properties)) return `${toolName}: parameters.properties must be an object`
  if (RESERVED_CALLER_KEYS.some((key) => Object.hasOwn(properties, key))) return `${toolName}: parameters must not declare ${RESERVED_CALLER_KEYS.join(" or ")}; the store stamps them`
  if (targetArg !== undefined && (typeof targetArg !== "string" || !Object.hasOwn(properties, targetArg))) return `${toolName}: targetArg ${String(targetArg)} must name a field of parameters.properties`
  if (awaited !== undefined) {
    if (!isRecord(awaited) || !nonEmpty(awaited.statusOp) || !nonEmpty(awaited.expireOp)) return `${toolName}: await needs statusOp and expireOp`
    const timeout = awaited.timeoutMs
    if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > AWAIT_TIMEOUT_MAX_MS) return `${toolName}: await.timeoutMs must be an integer from 1 to ${AWAIT_TIMEOUT_MAX_MS}`
    if (wakeDir === undefined) return `${toolName}: await needs the registration's wakeDir`
  }
  if (wake !== undefined && (typeof wake !== "string" || !WAKE_FILE.test(wake))) return `${toolName}: wake must be a plain file name matching ${WAKE_FILE.source}`
  if (wake !== undefined && wakeDir === undefined) return `${toolName}: wake needs the registration's wakeDir`
  return undefined
}

/** Why a declaration is invalid, or undefined; `exports` (the imported module) also checks every named op exists. */
export function declarationProblem(descriptor: Pick<StoreExtensionRegistration, "sessionCallable" | "wakeDir">, exports?: Readonly<Record<string, unknown>>): string | undefined {
  const { sessionCallable, wakeDir } = descriptor
  if (wakeDir !== undefined && (typeof wakeDir !== "string" || !WAKE_DIR.test(wakeDir))) return `wakeDir must be one path segment matching ${WAKE_DIR.source}`
  if (sessionCallable === undefined) return undefined
  if (!Array.isArray(sessionCallable)) return "sessionCallable must be an array"
  const names = new Set<string>()
  for (const entry of sessionCallable as readonly unknown[]) {
    const problem = entryProblem(entry, wakeDir)
    if (problem !== undefined) return problem
    const op = entry as SessionCallableOp
    if (names.has(op.toolName)) return `toolName ${op.toolName} is declared twice`
    names.add(op.toolName)
    if (exports === undefined) continue
    for (const name of [op.op, ...(op.await === undefined ? [] : [op.await.statusOp, op.await.expireOp])]) {
      if (!Object.hasOwn(exports, name) || typeof exports[name] !== "function") return `${op.toolName}: the module exports no operation ${name}`
    }
  }
  return undefined
}

/** Every op name a declaration reaches (op, statusOp, expireOp): the public channel refuses each. */
export function declaredOpNames(descriptor: Pick<StoreExtensionRegistration, "sessionCallable"> | undefined): ReadonlySet<string> {
  const names = new Set<string>()
  for (const entry of descriptor?.sessionCallable ?? []) {
    names.add(entry.op)
    if (entry.await !== undefined) for (const name of [entry.await.statusOp, entry.await.expireOp]) names.add(name)
  }
  return names
}

function parse(json: unknown): PersistedDescriptor | undefined {
  try {
    const value = JSON.parse(String(json)) as unknown
    if (!isRecord(value) || typeof value.moduleUrl !== "string" || !Array.isArray(value.migrations)) return undefined
    const descriptor = value as PersistedDescriptor
    return declarationProblem(descriptor) === undefined ? descriptor : undefined
  } catch {
    return undefined
  }
}

/** The persisted descriptor of one extension; a row that no longer passes the declaration rules reads as none. */
export function readDescriptor(ctx: StoreContext, name: string): PersistedDescriptor | undefined {
  const row = ctx.sql.one(["descriptor_json"], "SELECT descriptor_json FROM extension_registrations WHERE name = ?", [name])
  return row === undefined ? undefined : parse(row.descriptor_json)
}

/** Every declared session op, in extension-name order; one read, no import. */
export function listSessionOps(ctx: StoreContext): DeclaredSessionOp[] {
  const rows = ctx.sql.all(["name", "descriptor_json"], "SELECT name, descriptor_json FROM extension_registrations", [], "name")
  return rows.flatMap((row) => (parse(row.descriptor_json)?.sessionCallable ?? []).map((entry) => ({ ...entry, extension: String(row.name) })))
}

/** Upserts the descriptor (newest registration wins); refuses a toolName another extension already declares. Runs inside the caller's transaction. */
export function persistDescriptor(ctx: StoreContext, descriptor: StoreExtensionRegistration, now: number): string | undefined {
  const mine = new Set((descriptor.sessionCallable ?? []).map((entry) => entry.toolName))
  const taken = listSessionOps(ctx).find((entry) => entry.extension !== descriptor.name && mine.has(entry.toolName))
  if (taken !== undefined) return `toolName ${taken.toolName} is already declared by extension ${taken.extension}`
  const persisted: PersistedDescriptor = {
    moduleUrl: descriptor.moduleUrl,
    migrations: descriptor.migrations,
    ...(descriptor.sessionCallable === undefined ? {} : { sessionCallable: descriptor.sessionCallable }),
    ...(descriptor.wakeDir === undefined ? {} : { wakeDir: descriptor.wakeDir }),
  }
  ctx.sql.run(
    "INSERT INTO extension_registrations (name, descriptor_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET descriptor_json = excluded.descriptor_json, updated_at = excluded.updated_at",
    [descriptor.name, JSON.stringify(persisted), now],
  )
  return undefined
}

/** Imports a compiled extension module: a `file:` URL to .js/.mjs/.cjs only. Throws on any other URL or a failed import. */
export async function importExtensionModule(moduleUrl: string): Promise<Readonly<Record<string, unknown>>> {
  const url = new URL(moduleUrl)
  if (url.protocol !== "file:" || ![".js", ".mjs", ".cjs"].includes(extname(url.pathname))) {
    throw new Error("moduleUrl must name a compiled JavaScript file URL.")
  }
  // A module this worker imported before stays in the runtime's cache after its file is gone; a
  // deleted (uninstalled) extension must not keep running from that cache.
  if (!existsSync(fileURLToPath(url))) throw new Error(`The extension module ${moduleUrl} does not exist.`)
  return (await import(moduleUrl)) as Readonly<Record<string, unknown>>
}
