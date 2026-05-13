import type { ActorId, GatewayRule, GatewaySnapshot, ProtectedAgentRun } from '~/server/gateway'

export type SnapshotCommandResponse = {
  ok: boolean
  message?: string
  error?: string
  snapshot: GatewaySnapshot
}

export type RuleResponse = SnapshotCommandResponse & {
  rule?: GatewayRule
}

export type AgentRunResponse = SnapshotCommandResponse & {
  agentRun?: ProtectedAgentRun
}

export const fetchJson = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init?.headers,
    },
  })
  const payload = (await response.json()) as T & { error?: string }
  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed: ${response.status}`)
  }
  return payload
}

export const fetchSnapshot = () => fetchJson<GatewaySnapshot>('/api/snapshot')

export const approveRun = (actorId: ActorId, approvalId: string) =>
  fetchJson<SnapshotCommandResponse>('/api/approvals/approve', {
    method: 'POST',
    body: JSON.stringify({ actorId, approvalId }),
  })

export const clearRunState = () =>
  fetchJson<SnapshotCommandResponse>('/api/workspace/clear', {
    method: 'POST',
    body: JSON.stringify({}),
  })

export const createRule = (actorId: ActorId, text: string) =>
  fetchJson<RuleResponse>('/api/rules', {
    method: 'POST',
    body: JSON.stringify({ actorId, text }),
  })

export const evaluateAgentRun = () =>
  fetchJson<AgentRunResponse>('/api/agents/runs', {
    method: 'POST',
    body: JSON.stringify({ actorId: 'greg' }),
  })
