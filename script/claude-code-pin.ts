// script/claude-code-pin.ts
// The Claude Code package a compiled release binary downloads on its first Claude turn. Claude Code is
// ~220 MB and cannot be embedded under MAX_BINARY_BYTES, so the build instead stamps the exact platform
// package the engine's @anthropic-ai/claude-agent-sdk pins, with the npm dist.integrity bun.lock recorded
// for it; the runtime (packages/omo-senpi/src/components/claude-code) refuses any other bytes.

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { serializeClaudeCodePin, type ClaudeCodePin } from "../packages/omo-senpi/src/components/claude-code/pin"
import { resolvePackageDir } from "./engine-sidecar-sources"

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk"

const PLATFORM_BY_TARGET: Readonly<Record<string, string>> = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "darwin-x64-baseline": "darwin-x64",
  "linux-x64": "linux-x64",
  "linux-x64-baseline": "linux-x64",
  "linux-arm64": "linux-arm64",
  "linux-x64-musl": "linux-x64-musl",
  "linux-x64-musl-baseline": "linux-x64-musl",
  "linux-arm64-musl": "linux-arm64-musl",
  "windows-x64": "win32-x64",
  "windows-x64-baseline": "win32-x64",
  "windows-arm64": "win32-arm64",
}

export function claudeCodePackageName(releaseTarget: string): string {
  const platform = PLATFORM_BY_TARGET[releaseTarget]
  if (platform === undefined) throw new Error(`no Claude Code platform package is mapped for release target ${releaseTarget}`)
  return `${SDK_PACKAGE}-${platform}`
}

/** The sha512 bun.lock records for `name@version`; the lockfile's own trailing commas are tolerated. */
export function lockfileIntegrity(lockText: string, name: string, version: string): string {
  const entry = new RegExp(`\\[\\s*"${name.replace(/[/.-]/g, "\\$&")}@${version.replace(/\./g, "\\.")}"[^\\]]*?"(sha512-[A-Za-z0-9+/]+={0,2})"\\s*\\]`)
  const match = entry.exec(lockText)
  if (match?.[1] === undefined) throw new Error(`bun.lock has no sha512 integrity for ${name}@${version}`)
  return match[1]
}

export type ClaudeCodePinSources = {
  readonly sdkManifest: { readonly optionalDependencies?: Readonly<Record<string, string>> }
  readonly lockText: string
}

export function claudeCodePinForTarget(releaseTarget: string, sources: ClaudeCodePinSources): Omit<ClaudeCodePin, "marker"> {
  const name = claudeCodePackageName(releaseTarget)
  const version = sources.sdkManifest.optionalDependencies?.[name]
  if (version === undefined) throw new Error(`${SDK_PACKAGE} does not pin ${name}`)
  return {
    name,
    version,
    integrity: lockfileIntegrity(sources.lockText, name, version),
    binary: releaseTarget.startsWith("windows-") ? "claude.exe" : "claude",
  }
}

export function installedClaudeCodePinSources(repoRoot: string): ClaudeCodePinSources {
  const sdkDir = resolvePackageDir(SDK_PACKAGE)
  if (sdkDir === undefined) throw new Error(`${SDK_PACKAGE} is not resolvable from the installed engine`)
  return {
    sdkManifest: JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8")),
    lockText: readFileSync(join(repoRoot, "bun.lock"), "utf8"),
  }
}

export function claudeCodePinFileContent(releaseTarget: string, sources: ClaudeCodePinSources): string {
  return serializeClaudeCodePin(claudeCodePinForTarget(releaseTarget, sources))
}
