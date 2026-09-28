import type { Approval, GatewayRule, GatewaySnapshot, GatewayTask, ProtectedAgentRun } from '~/server/gateway'
import type {
  AgentRunLogResult,
  CreateLiveAgentRunInput,
  LiveAgent,
  LiveAgentRun,
  LiveImplementationSpec,
  LiveSwarm,
} from '~/server/kubernetes'

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

export type LiveAgentsResponse = {
  ok: boolean
  agents: LiveAgent[]
}

export type LiveAgentRunsResponse = {
  ok: boolean
  runs: LiveAgentRun[]
}

export type LiveImplementationSpecsResponse = {
  ok: boolean
  specs: LiveImplementationSpec[]
}

export type LiveSwarmsResponse = {
  ok: boolean
  swarms: LiveSwarm[]
}

export type CreateLiveAgentRunResponse = SnapshotCommandResponse & {
  run: LiveAgentRun
  agentRun?: ProtectedAgentRun
}

export type AgentRunLogsResponse = AgentRunLogResult & {
  ok: boolean
}

export type DatabaseAccessResponse = SnapshotCommandResponse & {
  approval?: Approval
  tables: string[]
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

export const fetchLiveAgents = () => fetchJson<LiveAgentsResponse>('/api/agents')

export const fetchLiveAgentRuns = () => fetchJson<LiveAgentRunsResponse>('/api/agent-runs')

export const fetchLiveImplementationSpecs = () =>
  fetchJson<LiveImplementationSpecsResponse>('/api/implementation-specs')

export const fetchLiveImplementationSpec = (name: string) =>
  fetchJson<{ ok: boolean; spec: LiveImplementationSpec }>(`/api/implementation-specs/${encodeURIComponent(name)}`)

export const fetchLiveSwarms = () => fetchJson<LiveSwarmsResponse>('/api/swarms')

export const fetchLiveSwarm = (name: string) =>
  fetchJson<{ ok: boolean; swarm: LiveSwarm }>(`/api/swarms/${encodeURIComponent(name)}`)

export const createLiveAgentRun = (input: CreateLiveAgentRunInput) =>
  fetchJson<CreateLiveAgentRunResponse>('/api/agent-runs', {
    method: 'POST',
    body: JSON.stringify(input),
  })

export const fetchAgentRunLogs = ({ namespace, name }: { namespace: string; name: string }) =>
  fetchJson<AgentRunLogsResponse>(
    `/api/agent-run-logs?namespace=${encodeURIComponent(namespace)}&name=${encodeURIComponent(name)}&tailLines=400`,
  )

export const requestDatabaseAccess = (name: string) =>
  fetchJson<DatabaseAccessResponse>(`/api/agent-runs/${encodeURIComponent(name)}/database-access`, {
    method: 'POST',
    body: JSON.stringify({}),
  })

export const fetchDatabaseAccess = (name: string) =>
  fetchJson<DatabaseAccessResponse>(`/api/agent-runs/${encodeURIComponent(name)}/database-access`)

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
