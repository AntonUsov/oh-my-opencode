import { CLAUDE_CODE_EXECUTABLE_ENV, locateClaudeCode } from "./locate"
import { readClaudeCodePin } from "./pin"

export function applyCachedClaudeCodeExecutable(env: NodeJS.ProcessEnv, packageDir: string): void {
  const pin = readClaudeCodePin(packageDir)
  if (pin === undefined) return
  const located = locateClaudeCode({ packageDir, pin, env })
  if (located.kind === "cached") env[CLAUDE_CODE_EXECUTABLE_ENV] = located.path
}
