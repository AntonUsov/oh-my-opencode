import { createHash, randomUUID } from "node:crypto"
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { claudeCodeCacheDir, claudeCodeCachePath, claudeCodeIntegrityMarker } from "./locate"
import type { ClaudeCodePin } from "./pin"
import { extractTarballEntry, TarballEntryMissingError } from "./tarball"

const DEFAULT_REGISTRY = "https://registry.npmjs.org"
const RESPONSE_TIMEOUT_MS = 30_000
const STALL_TIMEOUT_MS = 60_000

export type ClaudeCodeDownloadProgress = { readonly receivedBytes: number; readonly totalBytes: number | undefined }

export type ClaudeCodeAcquireFailure = "unreachable" | "http" | "integrity" | "archive"

export class ClaudeCodeAcquireError extends Error {
  constructor(
    readonly failure: ClaudeCodeAcquireFailure,
    readonly url: string,
    detail: string,
  ) {
    super(detail)
    this.name = "ClaudeCodeAcquireError"
  }
}

export type AcquireClaudeCodeOptions = {
  readonly packageDir: string
  readonly pin: ClaudeCodePin
  readonly env: NodeJS.ProcessEnv
  readonly fetch?: typeof globalThis.fetch
  readonly onProgress?: (progress: ClaudeCodeDownloadProgress) => void
}

export function claudeCodeRegistry(env: NodeJS.ProcessEnv): string {
  const configured = env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY
  return (configured !== undefined && configured.length > 0 ? configured : DEFAULT_REGISTRY).replace(/\/+$/, "")
}

export function claudeCodeTarballUrl(pin: ClaudeCodePin, env: NodeJS.ProcessEnv): string {
  const unscoped = pin.name.slice(pin.name.indexOf("/") + 1)
  return `${claudeCodeRegistry(env)}/${pin.name}/-/${unscoped}-${pin.version}.tgz`
}

function causeText(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const code: unknown = Reflect.get(error, "code")
  return typeof code === "string" && !error.message.includes(code) ? `${error.message} (${code})` : error.message
}

async function readBody(response: Response, url: string, onProgress: AcquireClaudeCodeOptions["onProgress"]): Promise<{ bytes: Uint8Array; digest: string }> {
  const header = response.headers.get("content-length")
  const totalBytes = header === null ? undefined : Number.parseInt(header, 10)
  const hash = createHash("sha512")
  const chunks: Uint8Array[] = []
  let receivedBytes = 0
  const reader = response.body?.getReader()
  if (reader === undefined) throw new ClaudeCodeAcquireError("http", url, "the registry answered without a body")
  for (;;) {
    let stall: ReturnType<typeof setTimeout> | undefined
    const next = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        stall = setTimeout(() => reject(new ClaudeCodeAcquireError("unreachable", url, `the download stalled for ${STALL_TIMEOUT_MS / 1000} s`)), STALL_TIMEOUT_MS)
      }),
    ]).finally(() => clearTimeout(stall))
    if (next.done) break
    hash.update(next.value)
    chunks.push(next.value)
    receivedBytes += next.value.byteLength
    onProgress?.({ receivedBytes, totalBytes: Number.isFinite(totalBytes) ? totalBytes : undefined })
  }
  return { bytes: Buffer.concat(chunks), digest: `sha512-${hash.digest("base64")}` }
}

function commit(options: AcquireClaudeCodeOptions, binary: Uint8Array): string {
  const directory = claudeCodeCacheDir(options.packageDir, options.pin)
  mkdirSync(directory, { recursive: true })
  const staging = join(directory, `.download-${randomUUID()}`)
  const markerStaging = `${staging}.integrity`
  try {
    writeFileSync(staging, binary)
    chmodSync(staging, 0o755)
    renameSync(staging, claudeCodeCachePath(options.packageDir, options.pin))
    writeFileSync(markerStaging, `${options.pin.integrity}\n`)
    renameSync(markerStaging, claudeCodeIntegrityMarker(options.packageDir, options.pin))
  } finally {
    rmSync(staging, { force: true })
    rmSync(markerStaging, { force: true })
  }
  return claudeCodeCachePath(options.packageDir, options.pin)
}

/**
 * Downloads the pinned platform package from the npm registry, rejects it unless its sha512 equals the
 * build-time `dist.integrity`, and installs its `claude` binary into the per-version cache. The marker
 * is written last, so a crash mid-install leaves nothing a later launch would trust.
 */
export async function acquireClaudeCode(options: AcquireClaudeCodeOptions): Promise<string> {
  const url = claudeCodeTarballUrl(options.pin, options.env)
  const fetchTarball = options.fetch ?? globalThis.fetch
  let response: Response
  try {
    response = await fetchTarball(url, { signal: AbortSignal.timeout(RESPONSE_TIMEOUT_MS) })
  } catch (error) {
    throw new ClaudeCodeAcquireError("unreachable", url, causeText(error))
  }
  if (!response.ok) throw new ClaudeCodeAcquireError("http", url, `HTTP ${response.status}`)
  let body: { bytes: Uint8Array; digest: string }
  try {
    body = await readBody(response, url, options.onProgress)
  } catch (error) {
    if (error instanceof ClaudeCodeAcquireError) throw error
    throw new ClaudeCodeAcquireError("unreachable", url, causeText(error))
  }
  if (body.digest !== options.pin.integrity) {
    throw new ClaudeCodeAcquireError("integrity", url, `sha512 mismatch: expected ${options.pin.integrity}, got ${body.digest}`)
  }
  let binary: Uint8Array
  try {
    binary = extractTarballEntry(body.bytes, `package/${options.pin.binary}`)
  } catch (error) {
    if (error instanceof TarballEntryMissingError) throw new ClaudeCodeAcquireError("archive", url, error.message)
    throw new ClaudeCodeAcquireError("archive", url, causeText(error))
  }
  return commit(options, binary)
}
