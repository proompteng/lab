import { createFileRoute } from '@tanstack/react-router'
import { buildSnapshot, evaluateAgentRun, isConnectorKind, resolveActorFromRequest } from '~/server/gateway'
import { listLiveAgentRuns } from '~/server/kubernetes'
import { loadGatewayState, saveGatewayState } from '~/server/persistence'

export const Route = createFileRoute('/api/agents/runs')({
  server: {
    handlers: {
      GET: async () => jsonResponse(buildSnapshot(await loadGatewayState())),
      POST: async ({ request }: SagServerRouteArgs) => {
        const payload = (await request.json().catch(() => null)) as AgentRunPayload | null
        const actor = resolveActorFromRequest(request)
        const state = await loadGatewayState()
        const requestedSecrets = payload?.requestedSecrets?.filter((item) => item.trim().length > 0)
        const requestedConnectors = payload?.requestedConnectors?.filter(isConnectorKind)
        const requestedTools = payload?.requestedTools?.filter((item) => item.trim().length > 0)
        const liveAgentRun = payload?.name
          ? null
          : (await listLiveAgentRuns()).find((item) => Boolean(item?.requestedSecrets?.length))
        const evaluationInput = liveAgentRun ?? {
          actorId: actor.id,
          name: payload?.name,
          namespace: payload?.namespace,
          agent: payload?.agent,
          requestedSecrets,
          requestedConnectors,
          requestedTools,
        }
        if (!liveAgentRun && !payload?.name && (!requestedSecrets || requestedSecrets.length === 0)) {
          return jsonResponse(
            {
              ok: false,
              error: 'No live protected workload with sensitive access was found',
              snapshot: buildSnapshot(state),
            },
            404,
          )
        }

        const agentRun = evaluateAgentRun(state, { ...evaluationInput, actorId: actor.id })
        await saveGatewayState(state)
        return jsonResponse({ ok: true, agentRun, snapshot: buildSnapshot(state) })
      },
    },
  },
})

type AgentRunPayload = {
  name?: string
  namespace?: string
  agent?: string
  requestedSecrets?: string[]
  requestedConnectors?: string[]
  requestedTools?: string[]
}

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
