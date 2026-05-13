import type { GatewayRule, GatewaySnapshot, GatewayTask, ProtectedAgentRun } from '~/server/gateway'

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

export type TaskResponse = SnapshotCommandResponse & {
  task?: GatewayTask
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

export const approveRun = (approvalId: string) =>
  fetchJson<SnapshotCommandResponse>('/api/approvals/approve', {
    method: 'POST',
    body: JSON.stringify({ approvalId }),
  })

export const clearRunState = () =>
  fetchJson<SnapshotCommandResponse>('/api/workspace/clear', {
    method: 'POST',
    body: JSON.stringify({}),
  })

export const createRule = (text: string) =>
  fetchJson<RuleResponse>('/api/rules', {
    method: 'POST',
    body: JSON.stringify({ text }),
  })

export const evaluateAgentRun = () =>
  fetchJson<AgentRunResponse>('/api/agents/runs', {
    method: 'POST',
    body: JSON.stringify({}),
  })

export const submitTask = (text: string) =>
  fetchJson<TaskResponse>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ text }),
  })
