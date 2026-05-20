import { fetchCodexRunByIdFromAgentsService, type CodexRunRecord } from '@proompteng/agent-contracts/codex-runs-client'

export type AgentRunRerunForwardingPayload = {
  agentRunId: string
  deliveryId: string
  payload: Record<string, unknown>
}

export type CodexRerunParentLookup = (runId: string) => Promise<CodexRunRecord | null>

const readString = (payload: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return null
}

const defaultLookupCodexRunById: CodexRerunParentLookup = async (runId) => {
  const result = await fetchCodexRunByIdFromAgentsService({ runId })
  if (!result.ok) {
    throw new Error(result.error ?? `Agents Codex run lookup failed with HTTP ${result.status}`)
  }
  return result.body.run
}

export const resolveAgentRunRerunForwardingPayload = async (
  payload: Record<string, unknown>,
  lookupCodexRunById: CodexRerunParentLookup = defaultLookupCodexRunById,
): Promise<AgentRunRerunForwardingPayload> => {
  const explicitAgentRunId = readString(payload, ['agentRunId', 'agent_run_id', 'agentRunName', 'agent_run_name'])
  const legacyRunId = readString(payload, ['run_id', 'runId'])
  const parentRun = explicitAgentRunId ? null : legacyRunId ? await lookupCodexRunById(legacyRunId) : null
  const agentRunId = explicitAgentRunId ?? parentRun?.agentRunName ?? null

  if (!agentRunId) {
    throw new Error('rerun payload missing AgentRun identity')
  }

  const agentRunNamespace =
    readString(payload, ['agentRunNamespace', 'agent_run_namespace']) ?? parentRun?.agentRunNamespace ?? null
  const agentRunUid = readString(payload, ['agentRunUid', 'agent_run_uid']) ?? parentRun?.agentRunUid ?? null
  const attempt = readString(payload, ['attempt', 'rerun_attempt'])
  const deliveryId =
    readString(payload, ['deliveryId', 'delivery_id']) ?? (attempt ? `${agentRunId}:${attempt}` : `${agentRunId}:rerun`)

  return {
    agentRunId,
    deliveryId,
    payload: {
      ...payload,
      runId: agentRunId,
      agentRunName: agentRunId,
      ...(agentRunNamespace ? { agentRunNamespace } : {}),
      ...(agentRunUid ? { agentRunUid } : {}),
      deliveryId,
      legacyCodexRunId: parentRun?.id ?? legacyRunId ?? null,
    },
  }
}
