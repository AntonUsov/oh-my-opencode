import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ClaudeCodeAcquireError, type AcquireClaudeCodeOptions } from "./acquire"
import { compiledPayloadDir, fakeTarball, pinFor } from "./claude-code.test-support"
import { CLAUDE_CODE_STATUS_KEY, createClaudeCodeComponent } from "./component"
import { applyCachedClaudeCodeExecutable } from "./launch"
import { claudeCodeCacheDir, claudeCodeCachePath, claudeCodeIntegrityMarker } from "./locate"

type Handler = (payload: unknown, eventCtx: unknown) => unknown

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omo-claude-code-component-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function harness(options: { readonly withPin?: boolean; readonly pathDir?: string; readonly acquire?: (options: AcquireClaudeCodeOptions) => Promise<string> } = {}) {
  const pin = pinFor(fakeTarball())
  const packageDir = options.withPin === false ? tempDir() : compiledPayloadDir(pin)
  cleanups.push(() => rmSync(packageDir, { recursive: true, force: true }))
  const env: NodeJS.ProcessEnv = { OMO_PACKAGE_DIR: packageDir, PATH: options.pathDir ?? tempDir() }
  const handlers = new Map<string, Handler[]>()
  const notices: Array<{ message: string; level: string }> = []
  const statuses: Array<string | undefined> = []
  const acquisitions: AcquireClaudeCodeOptions[] = []
  const acquire = options.acquire ?? (async (acquireOptions: AcquireClaudeCodeOptions) => {
    acquisitions.push(acquireOptions)
    acquireOptions.onProgress?.({ receivedBytes: 50, totalBytes: 100 })
    return "/cache/claude"
  })
  createClaudeCodeComponent({ env, acquire: async (acquireOptions) => acquire(acquireOptions) }).register(
    { on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]) } as never,
    { logger: { info() {}, warn() {}, error() {} } } as never,
  )
  const eventCtx = (provider: string) => ({
    hasUI: true,
    model: { provider, id: "claude-haiku-4-5" },
    ui: {
      notify: (message: string, level: string) => notices.push({ message, level }),
      setStatus: (key: string, text: string | undefined) => key === CLAUDE_CODE_STATUS_KEY && statuses.push(text),
    },
  })
  const input = (provider = "anthropic-subscription") =>
    Promise.all((handlers.get("input") ?? []).map((handler) => handler({ type: "input", text: "hi" }, eventCtx(provider))))
  return { pin, packageDir, env, handlers, notices, statuses, acquisitions, input }
}

describe("createClaudeCodeComponent", () => {
  test("#given an npm install without the compiled pin #then no input handler is registered", () => {
    const { handlers } = harness({ withPin: false })
    expect(handlers.get("input")).toBeUndefined()
  })

  test("#given a compiled payload and no Claude Code #when two Claude turns start together #then one verified download serves both", async () => {
    const { env, acquisitions, notices, statuses, input } = harness()

    await Promise.all([input(), input()])

    expect(acquisitions).toHaveLength(1)
    expect(env.CLAUDE_CODE_EXECUTABLE).toBe("/cache/claude")
    expect(notices.map((notice) => notice.level)).toEqual(["info", "info", "info"])
    expect(statuses).toEqual(["Downloading Claude Code 0.3.284: 50% of 0 MB", undefined, undefined])
  })

  test("#given a turn on another provider #then nothing is downloaded", async () => {
    const { acquisitions, env, input } = harness()
    await input("openai")
    expect(acquisitions).toHaveLength(0)
    expect(env.CLAUDE_CODE_EXECUTABLE).toBeUndefined()
  })

  test("#given claude on PATH #then the download is skipped and senpi keeps using it", async () => {
    const pathDir = tempDir()
    const claude = join(pathDir, process.platform === "win32" ? "claude.exe" : "claude")
    writeFileSync(claude, "#!/bin/sh\n")
    chmodSync(claude, 0o755)
    const { acquisitions, env, input } = harness({ pathDir })
    await input()
    expect(acquisitions).toHaveLength(0)
    expect(env.CLAUDE_CODE_EXECUTABLE).toBeUndefined()
  })

  test("#given the registry is unreachable #then the turn gets an error notice and the next turn retries", async () => {
    let attempts = 0
    const { env, notices, input } = harness({
      acquire: async (options) => {
        attempts += 1
        throw new ClaudeCodeAcquireError("unreachable", `${options.env.npm_config_registry ?? "https://registry.npmjs.org"}/x.tgz`, "Unable to connect")
      },
    })

    await input()
    await input()

    expect(attempts).toBe(2)
    expect(env.CLAUDE_CODE_EXECUTABLE).toBeUndefined()
    expect(notices.filter((notice) => notice.level === "error").map((notice) => notice.message.includes("could not reach https://registry.npmjs.org"))).toEqual([true, true])
  })
})

describe("applyCachedClaudeCodeExecutable", () => {
  function cache(packageDir: string) {
    const pin = pinFor(fakeTarball())
    mkdirSync(claudeCodeCacheDir(packageDir, pin), { recursive: true })
    writeFileSync(claudeCodeCachePath(packageDir, pin), "#!/bin/sh\n")
    writeFileSync(claudeCodeIntegrityMarker(packageDir, pin), `${pin.integrity}\n`)
    return claudeCodeCachePath(packageDir, pin)
  }

  test("#given a downloaded Claude Code #when a compiled binary launches #then senpi is pointed at it", () => {
    const packageDir = compiledPayloadDir(pinFor(fakeTarball()))
    cleanups.push(() => rmSync(packageDir, { recursive: true, force: true }))
    const cached = cache(packageDir)
    const env: NodeJS.ProcessEnv = { PATH: tempDir() }
    applyCachedClaudeCodeExecutable(env, packageDir)
    expect(env.CLAUDE_CODE_EXECUTABLE).toBe(cached)
  })

  test("#given a cache whose marker names another integrity #then it is not trusted", () => {
    const packageDir = compiledPayloadDir(pinFor(fakeTarball()))
    cleanups.push(() => rmSync(packageDir, { recursive: true, force: true }))
    cache(packageDir)
    writeFileSync(claudeCodeIntegrityMarker(packageDir, pinFor(fakeTarball())), "sha512-other\n")
    const env: NodeJS.ProcessEnv = { PATH: tempDir() }
    applyCachedClaudeCodeExecutable(env, packageDir)
    expect(env.CLAUDE_CODE_EXECUTABLE).toBeUndefined()
  })
})
