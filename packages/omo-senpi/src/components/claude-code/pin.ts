import { readFileSync } from "node:fs"
import { join } from "node:path"

import { z } from "zod"

/**
 * The Claude Code package a compiled omo binary downloads on its first Claude turn. The release
 * build writes it (script/claude-code-pin.ts) from the engine's `@anthropic-ai/claude-agent-sdk`
 * pin and the lockfile's npm `dist.integrity`, so the download is checked against a digest fixed at
 * build time. Only the compiled payload carries this file: an npm install ships the SDK's platform
 * sidecar instead, and its absence is what keeps every other install from downloading anything.
 */
export const CLAUDE_CODE_PIN_FILE = "claude-code.json"
export const CLAUDE_CODE_PIN_MARKER = "OMO_CLAUDE_CODE_PIN_V1"

const claudeCodePinSchema = z.object({
  marker: z.literal(CLAUDE_CODE_PIN_MARKER),
  name: z.string().regex(/^@anthropic-ai\/claude-agent-sdk-[a-z0-9-]+$/),
  version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/),
  integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/),
  binary: z.enum(["claude", "claude.exe"]),
})

export type ClaudeCodePin = z.infer<typeof claudeCodePinSchema>

export function readClaudeCodePin(packageDir: string | undefined): ClaudeCodePin | undefined {
  if (packageDir === undefined || packageDir.length === 0) return undefined
  let text: string
  try {
    text = readFileSync(join(packageDir, CLAUDE_CODE_PIN_FILE), "utf8")
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return undefined
    throw error
  }
  return claudeCodePinSchema.parse(JSON.parse(text))
}

export function serializeClaudeCodePin(pin: Omit<ClaudeCodePin, "marker">): string {
  return `${JSON.stringify(claudeCodePinSchema.parse({ marker: CLAUDE_CODE_PIN_MARKER, ...pin }), null, 2)}\n`
}
