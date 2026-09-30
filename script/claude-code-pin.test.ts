import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { readClaudeCodePin } from "../packages/omo-senpi/src/components/claude-code/pin"
import { RELEASE_BINARY_TARGETS } from "./build-omo-binary"
import { claudeCodePinFileContent, claudeCodePinForTarget, installedClaudeCodePinSources, lockfileIntegrity } from "./claude-code-pin"

const repoRoot = resolve(import.meta.dir, "..")

describe("claudeCodePinForTarget", () => {
  test("#given the installed engine and bun.lock #then every release target pins its platform package at the engine's SDK version with a sha512", () => {
    const sources = installedClaudeCodePinSources(repoRoot)
    for (const target of RELEASE_BINARY_TARGETS) {
      const pin = claudeCodePinForTarget(target.target, sources)
      expect(pin.version).toBe(sources.sdkManifest.optionalDependencies?.[pin.name] ?? "unpinned")
      expect(pin.integrity).toMatch(/^sha512-/)
      expect(pin.binary).toBe(target.os === "windows" ? "claude.exe" : "claude")
    }
  })

  test("#given a musl target #then the musl package is pinned, not the glibc one", () => {
    const pin = claudeCodePinForTarget("linux-x64-musl-baseline", installedClaudeCodePinSources(repoRoot))
    expect(pin.name).toBe("@anthropic-ai/claude-agent-sdk-linux-x64-musl")
  })

  test("#given a lockfile without the pinned version #then the build refuses to stamp a pin", () => {
    const lockText = '"@anthropic-ai/claude-agent-sdk-darwin-arm64": ["@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.1", "", {}, "sha512-abc=="],'
    expect(() => lockfileIntegrity(lockText, "@anthropic-ai/claude-agent-sdk-darwin-arm64", "0.3.284")).toThrow("no sha512 integrity")
  })

  test("#given the stamped file #then the runtime parser reads back the same pin", () => {
    const sources = installedClaudeCodePinSources(repoRoot)
    const dir = mkdtempSync(join(tmpdir(), "claude-code-pin-"))
    try {
      writeFileSync(join(dir, "claude-code.json"), claudeCodePinFileContent("darwin-arm64", sources))
      expect(readClaudeCodePin(dir)).toEqual({ marker: "OMO_CLAUDE_CODE_PIN_V1", ...claudeCodePinForTarget("darwin-arm64", sources) })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
