import { afterEach, describe, expect, test } from "bun:test"
import { accessSync, constants, existsSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

import { acquireClaudeCode, ClaudeCodeAcquireError, claudeCodeTarballUrl, type ClaudeCodeDownloadProgress } from "./acquire"
import { compiledPayloadDir, FAKE_CLAUDE, fakeTarball, packTarball, pinFor, serveTarball } from "./claude-code.test-support"
import { cachedClaudeCode, claudeCodeCacheDir } from "./locate"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function payload(tarball: Uint8Array, pinnedTo: Uint8Array = tarball) {
  const pin = pinFor(pinnedTo)
  const packageDir = compiledPayloadDir(pin)
  const registry = serveTarball(tarball)
  cleanups.push(() => registry.stop(), () => rmSync(packageDir, { recursive: true, force: true }))
  return { pin, packageDir, registry, env: { npm_config_registry: registry.registry } }
}

async function failureOf(promise: Promise<unknown>): Promise<ClaudeCodeAcquireError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ClaudeCodeAcquireError) return error
    throw error
  }
  throw new Error("expected the acquisition to fail")
}

describe("acquireClaudeCode", () => {
  test("#given the registry serves the pinned tarball #when acquired #then the verified binary is cached executable with progress reported", async () => {
    const tarball = fakeTarball()
    const { pin, packageDir, registry, env } = payload(tarball)
    const progress: ClaudeCodeDownloadProgress[] = []

    const path = await acquireClaudeCode({ packageDir, pin, env, onProgress: (entry) => progress.push(entry) })

    expect(registry.requests).toEqual(["/@anthropic-ai/claude-agent-sdk-darwin-arm64/-/claude-agent-sdk-darwin-arm64-0.3.284.tgz"])
    expect(readFileSync(path)).toEqual(Buffer.from(FAKE_CLAUDE))
    accessSync(path, constants.X_OK)
    expect(cachedClaudeCode(packageDir, pin)).toBe(path)
    expect(progress.at(-1)).toEqual({ receivedBytes: tarball.byteLength, totalBytes: tarball.byteLength })
  })

  test("#given bytes that do not match the pinned sha512 #when acquired #then it fails the integrity check and caches nothing", async () => {
    const { pin, packageDir, env } = payload(packTarball({ "package/claude": new TextEncoder().encode("tampered") }), fakeTarball())

    const error = await failureOf(acquireClaudeCode({ packageDir, pin, env }))

    expect(error.failure).toBe("integrity")
    expect(cachedClaudeCode(packageDir, pin)).toBeUndefined()
    expect(existsSync(claudeCodeCacheDir(packageDir, pin))).toBe(false)
  })

  test("#given the registry is unreachable #when acquired #then it fails as unreachable and caches nothing", async () => {
    const { pin, packageDir, registry, env } = payload(fakeTarball())
    registry.stop()

    const error = await failureOf(acquireClaudeCode({ packageDir, pin, env }))

    expect(error.failure).toBe("unreachable")
    expect(error.url.startsWith(env.npm_config_registry)).toBe(true)
    expect(cachedClaudeCode(packageDir, pin)).toBeUndefined()
  })

  test("#given a verified tarball without the binary #when acquired #then it fails as archive and leaves no staging file", async () => {
    const tarball = packTarball({ "package/package.json": new TextEncoder().encode("{}") })
    const { pin, packageDir, env } = payload(tarball)

    const error = await failureOf(acquireClaudeCode({ packageDir, pin, env }))

    expect(error.failure).toBe("archive")
    expect(existsSync(claudeCodeCacheDir(packageDir, pin)) ? readdirSync(claudeCodeCacheDir(packageDir, pin)) : []).toEqual([])
    expect(existsSync(join(packageDir, "claude-code"))).toBe(false)
  })
})

describe("claudeCodeTarballUrl", () => {
  test("#given no registry setting #then the public npm registry tarball path is used", () => {
    expect(claudeCodeTarballUrl(pinFor(fakeTarball()), {})).toBe(
      "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-darwin-arm64/-/claude-agent-sdk-darwin-arm64-0.3.284.tgz",
    )
  })
})
