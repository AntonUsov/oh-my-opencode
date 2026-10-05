import type { ToolCallEventResult } from "@code-yeongyu/senpi"

import type { ComponentLogger, SenpiExtensionAPI } from "../../extension/types"
import { THREAD_TOOL_SEARCH_METADATA } from "../thread/metadata"
import { gatewaySessionId, type GatewayScopeAccess } from "./scope-access"

const LEAD_TOOL_NAMES = new Set([
  ...THREAD_TOOL_SEARCH_METADATA.map(({ name }) => name),
  "memory", "memory_apply_patch", "gateway_learning",
  "read", "grep", "find", "ls", "glob",
])

export function registerGatewayLeadToolGuard(
  pi: SenpiExtensionAPI,
  access: GatewayScopeAccess,
  logger: ComponentLogger,
): void {
  pi.on("tool_call", async (payload, eventCtx): Promise<ToolCallEventResult | undefined> => {
    const sessionId = gatewaySessionId(eventCtx)
    if (sessionId === undefined || payload === null || typeof payload !== "object") return undefined
    const toolName: unknown = Reflect.get(payload, "toolName")
    if (typeof toolName !== "string") return undefined

    let member
    try {
      member = await access.member(sessionId)
    } catch (error) {
      // A failed lookup cannot establish lead membership; do not disable unrelated sessions.
      logger.warn(`gateway scope lead lookup failed; tool call proceeds: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
    if (member?.role !== "lead") return undefined
    if (LEAD_TOOL_NAMES.has(toolName) || /^ext_omo_gateway_[a-z][a-z0-9_]{1,40}$/.test(toolName)) return undefined
    return {
      block: true,
      reason: `this session leads gateway scope ${member.scope}: it routes work to sessions instead of running tools like ${toolName}; open a work item`,
    }
  })
}
