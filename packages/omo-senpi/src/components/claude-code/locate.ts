import { accessSync, constants, readFileSync, statSync } from "node:fs"
import { delimiter, join } from "node:path"

import type { ClaudeCodePin } from "./pin"

export const CLAUDE_CODE_EXECUTABLE_ENV = "CLAUDE_CODE_EXECUTABLE"
const INTEGRITY_MARKER = ".integrity"

export type ClaudeCodeSource =
  | { readonly kind: "override"; readonly path: string }
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "cached"; readonly path: string }
  | { readonly kind: "absent" }

export type ClaudeCodeLocateInput = {
  readonly packageDir: string
  readonly pin: ClaudeCodePin
  readonly env: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
}

export function claudeCodeCacheDir(packageDir: string, pin: ClaudeCodePin): string {
  return join(packageDir, "claude-code", pin.version)
}

export function claudeCodeIntegrityMarker(packageDir: string, pin: ClaudeCodePin): string {
  return join(claudeCodeCacheDir(packageDir, pin), INTEGRITY_MARKER)
}

export function claudeCodeCachePath(packageDir: string, pin: ClaudeCodePin): string {
  return join(claudeCodeCacheDir(packageDir, pin), pin.binary)
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch (error) {
    if (error instanceof Error && "code" in error) return false
    throw error
  }
}

function isExecutable(path: string, platform: NodeJS.Platform): boolean {
  if (!isFile(path)) return false
  if (platform === "win32") return true
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error) return false
    throw error
  }
}

function readMarker(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim()
  } catch (error) {
    if (error instanceof Error && "code" in error) return undefined
    throw error
  }
}

export function cachedClaudeCode(packageDir: string, pin: ClaudeCodePin): string | undefined {
  const path = claudeCodeCachePath(packageDir, pin)
  return readMarker(claudeCodeIntegrityMarker(packageDir, pin)) === pin.integrity && isFile(path) ? path : undefined
}

function claudeOnPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH"
  const extensions = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""]
  for (const directory of (env[pathKey] ?? "").split(platform === "win32" ? ";" : delimiter)) {
    if (directory.length === 0) continue
    for (const extension of extensions) {
      const candidate = join(directory, `claude${extension.toLowerCase()}`)
      if (isExecutable(candidate, platform)) return candidate
    }
  }
  return undefined
}

/**
 * Mirrors the order senpi resolves Claude Code in (anthropic-subscription/executable.ts): an explicit
 * CLAUDE_CODE_EXECUTABLE, then (no sidecar in a compiled binary) `claude` on PATH. Only when both are
 * missing does the pinned download stand in for the sidecar an npm install would carry.
 */
export function locateClaudeCode(input: ClaudeCodeLocateInput): ClaudeCodeSource {
  const platform = input.platform ?? process.platform
  const override = input.env[CLAUDE_CODE_EXECUTABLE_ENV]
  if (override !== undefined && override.length > 0 && isFile(override)) return { kind: "override", path: override }
  const onPath = claudeOnPath(input.env, platform)
  if (onPath !== undefined) return { kind: "path", path: onPath }
  const cached = cachedClaudeCode(input.packageDir, input.pin)
  return cached === undefined ? { kind: "absent" } : { kind: "cached", path: cached }
}
