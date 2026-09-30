import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"

import { type ClaudeCodePin, serializeClaudeCodePin } from "./pin"

function header(name: string, size: number): Uint8Array {
  const block = new Uint8Array(512)
  const put = (offset: number, text: string) => block.set(new TextEncoder().encode(text), offset)
  put(0, name)
  put(100, "0000755\0")
  put(108, "0000000\0")
  put(116, "0000000\0")
  put(124, `${size.toString(8).padStart(11, "0")}\0`)
  put(136, "00000000000\0")
  put(156, "0")
  put(257, "ustar\0")
  put(263, "00")
  block.fill(32, 148, 156)
  const checksum = block.reduce((sum, byte) => sum + byte, 0)
  put(148, `${checksum.toString(8).padStart(6, "0")}\0 `)
  return block
}

export function packTarball(entries: Readonly<Record<string, Uint8Array>>): Uint8Array {
  const parts: Uint8Array[] = []
  for (const [name, bytes] of Object.entries(entries)) {
    parts.push(header(name, bytes.byteLength), bytes, new Uint8Array((512 - (bytes.byteLength % 512)) % 512))
  }
  parts.push(new Uint8Array(1024))
  return gzipSync(Buffer.concat(parts))
}

export function sriOf(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`
}

export const FAKE_CLAUDE = new TextEncoder().encode("#!/bin/sh\necho 'fake claude 2.1.284'\n")

export function fakeTarball(): Uint8Array {
  return packTarball({
    "package/package.json": new TextEncoder().encode('{"name":"@anthropic-ai/claude-agent-sdk-darwin-arm64","version":"0.3.284"}'),
    "package/claude": FAKE_CLAUDE,
  })
}

export function pinFor(tarball: Uint8Array): ClaudeCodePin {
  return {
    marker: "OMO_CLAUDE_CODE_PIN_V1",
    name: "@anthropic-ai/claude-agent-sdk-darwin-arm64",
    version: "0.3.284",
    integrity: sriOf(tarball),
    binary: "claude",
  }
}

export function compiledPayloadDir(pin: ClaudeCodePin): string {
  const dir = mkdtempSync(join(tmpdir(), "omo-claude-code-"))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "claude-code.json"), serializeClaudeCodePin(pin))
  return dir
}

export function serveTarball(tarball: Uint8Array): { readonly registry: string; readonly requests: string[]; stop(): void } {
  const requests: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      requests.push(new URL(request.url).pathname)
      return new Response(tarball, { headers: { "content-length": String(tarball.byteLength) } })
    },
  })
  return { registry: `http://127.0.0.1:${server.port}`, requests, stop: () => void server.stop(true) }
}
