import { createFileRoute } from '@tanstack/react-router'
import { buildSnapshot, evaluateAgentRun, type ActorId, type ConnectorKind } from '~/server/gateway'
import { listLiveAgentRuns } from '~/server/kubernetes'
import { loadGatewayState, saveGatewayState } from '~/server/persistence'

export const Route = createFileRoute('/api/agents/runs')({
  server: {
    handlers: {
      GET: async () => jsonResponse(buildSnapshot(await loadGatewayState())),
      POST: async ({ request }: SagServerRouteArgs) => {
        const payload = (await request.json().catch(() => null)) as AgentRunPayload | null
        const actorId = isActorId(payload?.actorId) ? payload.actorId : 'greg'
        const state = await loadGatewayState()
        const requestedSecrets = payload?.requestedSecrets?.filter((item) => item.trim().length > 0)
        const requestedConnectors = payload?.requestedConnectors?.filter(isConnectorKind)
        const requestedTools = payload?.requestedTools?.filter((item) => item.trim().length > 0)
        const liveAgentRun = payload?.name
          ? null
          : (await listLiveAgentRuns()).find((item) => Boolean(item?.requestedSecrets?.length))
        const evaluationInput = liveAgentRun ?? {
          actorId,
          name: payload?.name,
          namespace: payload?.namespace,
          agent: payload?.agent,
          requestedSecrets,
          requestedConnectors,
          requestedTools,
        }
        if (!liveAgentRun && !payload?.name && (!requestedSecrets || requestedSecrets.length === 0)) {
          return jsonResponse(
            { ok: false, error: 'No live AgentRun with requested secrets was found', snapshot: buildSnapshot(state) },
            404,
          )
        }

        const agentRun = evaluateAgentRun(state, { ...evaluationInput, actorId })
        await saveGatewayState(state)
        return jsonResponse({ ok: true, agentRun, snapshot: buildSnapshot(state) })
      },
    },
  },
})

type AgentRunPayload = {
  actorId?: string
  name?: string
  namespace?: string
  agent?: string
  requestedSecrets?: string[]
  requestedConnectors?: string[]
  requestedTools?: string[]
}

const isActorId = (value: unknown): value is ActorId => value === 'greg' || value === 'ops' || value === 'audit'

const isConnectorKind = (value: unknown): value is ConnectorKind =>
  value === 'kubernetes' || value === 'postgres' || value === 'policy' || value === 'audit'

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
