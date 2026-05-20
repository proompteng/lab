import {
  buildAgentsServiceUrl,
  fetchAgentsJsonEffect,
  runAgentsJsonPromise,
  servicePath,
  type AgentsServiceJsonResult,
  type EnvSource,
} from './agents-http'

export type AgentsProjectionAuthorityState = 'authoritative' | 'grace' | 'stale_foreclosed' | 'terminal_audit'

export type AgentsProjectionValueGate =
  | 'failed_agentrun_rate'
  | 'ready_status_truth'
  | 'manual_intervention_count'
  | 'handoff_evidence_quality'

export type AgentsAgentRunProjectionAuthorityClaim = {
  claim_id: string
  claim_class: 'agentrun_execution'
  source_ref: string
  source_owner: string
  lane: string | null
  status: string
  observed_at: string | null
  last_heartbeat_at: string | null
  fresh_until: string | null
  live_authority_ref: string | null
  projection_ref: string | null
  authority_state: AgentsProjectionAuthorityState
  reason_codes: string[]
  value_gates: AgentsProjectionValueGate[]
}

export type AgentsAgentRunProjectionAuthorityResult = {
  ok: boolean
  schemaVersion: 'agents.agentrun-projection-authority.v1' | string
  generatedAt: string
  total: number
  claims: AgentsAgentRunProjectionAuthorityClaim[]
}

export type AgentsAgentRunProjectionAuthorityInput = {
  agentName?: string | null
  limit?: number | null
  includeTerminalAudit?: boolean | null
}

export const fetchAgentRunProjectionAuthorityFromAgentsServiceEffect = (
  input: AgentsAgentRunProjectionAuthorityInput = {},
  env: EnvSource = process.env,
) => {
  const targetUrl = buildAgentsServiceUrl('/v1/agent-runs/projection-authority', env)
  const agentName = input.agentName?.trim()
  if (agentName) targetUrl.searchParams.set('agentName', agentName)
  if (input.limit && input.limit > 0) targetUrl.searchParams.set('limit', String(Math.trunc(input.limit)))
  if (input.includeTerminalAudit !== undefined && input.includeTerminalAudit !== null) {
    targetUrl.searchParams.set('includeTerminalAudit', input.includeTerminalAudit ? 'true' : 'false')
  }

  return fetchAgentsJsonEffect<AgentsAgentRunProjectionAuthorityResult>(servicePath(targetUrl), env)
}

export const fetchAgentRunProjectionAuthorityFromAgentsService = async (
  input: AgentsAgentRunProjectionAuthorityInput = {},
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsAgentRunProjectionAuthorityResult>> =>
  runAgentsJsonPromise(fetchAgentRunProjectionAuthorityFromAgentsServiceEffect(input, env))
