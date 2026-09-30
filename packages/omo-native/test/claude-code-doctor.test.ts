import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { claudeCodeDoctorLines } from "../claude-code-doctor"
import { compiledPayloadDir, fakeTarball, pinFor } from "../../omo-senpi/src/components/claude-code/claude-code.test-support"
import { claudeCodeCacheDir, claudeCodeCachePath, claudeCodeIntegrityMarker } from "../../omo-senpi/src/components/claude-code/locate"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function dir(make: () => string): string {
  const path = make()
  cleanups.push(() => rmSync(path, { recursive: true, force: true }))
  return path
}

describe("claudeCodeDoctorLines", () => {
  const pin = pinFor(fakeTarball())
  const emptyPath = () => ({ PATH: dir(() => mkdtempSync(join(tmpdir(), "omo-doctor-path-"))) })

  test("#given an npm install without the compiled pin #then doctor prints no Claude Code line", () => {
    expect(claudeCodeDoctorLines(dir(() => mkdtempSync(join(tmpdir(), "omo-doctor-npm-"))), emptyPath())).toEqual([])
  })

  test("#given a compiled payload before its first Claude turn #then doctor says it is not downloaded yet, without fetching", () => {
    const originalFetch = globalThis.fetch
    let fetches = 0
    globalThis.fetch = Object.assign(async () => {
      fetches += 1
      return new Response()
    }, { preconnect: originalFetch.preconnect })
    try {
      const [line] = claudeCodeDoctorLines(dir(() => compiledPayloadDir(pin)), emptyPath())
      expect(line?.startsWith("INFO claude code: not downloaded yet")).toBe(true)
      expect(fetches).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("#given the download finished #then doctor reports the cached executable", () => {
    const packageDir = dir(() => compiledPayloadDir(pin))
    mkdirSync(claudeCodeCacheDir(packageDir, pin), { recursive: true })
    writeFileSync(claudeCodeCachePath(packageDir, pin), "#!/bin/sh\n")
    writeFileSync(claudeCodeIntegrityMarker(packageDir, pin), `${pin.integrity}\n`)
    expect(claudeCodeDoctorLines(packageDir, emptyPath())).toEqual([
      `PASS claude code: ${pin.name}@${pin.version} downloaded (${claudeCodeCachePath(packageDir, pin)})`,
    ])
  })
})
