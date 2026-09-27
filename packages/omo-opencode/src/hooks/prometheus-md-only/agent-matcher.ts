import { getAgentDisplayName, stripAgentListSortPrefix } from "../../shared/agent-display-names"
import { PROMETHEUS_AGENT } from "./constants"

export type AgentDisplayNameOverrides = Record<string, { displayName?: string } | undefined>

export function isPrometheusAgent(agentName: string | undefined): boolean {
  return agentName?.toLowerCase().includes(PROMETHEUS_AGENT) ?? false
}

export function isConfiguredPrometheusAgent(
  agentName: string | undefined,
  overrides: AgentDisplayNameOverrides | undefined,
): boolean {
  if (isPrometheusAgent(agentName)) return true
  if (agentName === undefined) return false
  const displayName = getAgentDisplayName(PROMETHEUS_AGENT, overrides)
  return stripAgentListSortPrefix(agentName).trim().toLowerCase() === displayName.trim().toLowerCase()
}
