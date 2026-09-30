import { claudeCodeRegistry } from "../omo-senpi/src/components/claude-code/acquire"
import { CLAUDE_CODE_EXECUTABLE_ENV, locateClaudeCode } from "../omo-senpi/src/components/claude-code/locate"
import { readClaudeCodePin } from "../omo-senpi/src/components/claude-code/pin"

export function claudeCodeDoctorLines(packageDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const pin = readClaudeCodePin(packageDir)
  if (pin === undefined) return []
  const located = locateClaudeCode({ packageDir, pin, env })
  switch (located.kind) {
    case "override":
      return [`PASS claude code: ${CLAUDE_CODE_EXECUTABLE_ENV} (${located.path})`]
    case "path":
      return [`PASS claude code: claude on PATH (${located.path})`]
    case "cached":
      return [`PASS claude code: ${pin.name}@${pin.version} downloaded (${located.path})`]
    case "absent":
      return [`INFO claude code: not downloaded yet; the first Claude turn downloads ${pin.name}@${pin.version} from ${claudeCodeRegistry(env)} (sha512-verified)`]
    default: {
      const unreachable: never = located
      return unreachable
    }
  }
}
