import { createFileRoute } from '@tanstack/react-router'
import { buildSnapshot, evaluateAgentRun, resolveActorFromRequest } from '~/server/gateway'
import { createLiveAgentRun, listAgentRuns, type CreateLiveAgentRunInput } from '~/server/kubernetes'
import { loadGatewayState, saveGatewayState } from '~/server/persistence'

export const Route = createFileRoute('/api/agent-runs')({
  server: {
    handlers: {
      GET: async () => jsonResponse({ ok: true, runs: await listAgentRuns({ namespace: 'agents' }) }),
      POST: async ({ request }: SagServerRouteArgs) => {
        const payload = (await request.json().catch(() => null)) as CreateAgentRunPayload | null
        const task = payload?.task?.trim()
        if (!task) return jsonResponse({ ok: false, error: 'Task is required' }, 400)

        const actor = resolveActorFromRequest(request)
        const run = await createLiveAgentRun({
          name: payload?.name,
          namespace: payload?.namespace,
          agent: payload?.agent,
          task,
          repository: payload?.repository,
          base: payload?.base,
          head: payload?.head,
          issueNumber: payload?.issueNumber,
          issueTitle: payload?.issueTitle,
          issueUrl: payload?.issueUrl,
        })

        const state = await loadGatewayState()
        const agentRun = evaluateAgentRun(state, {
          actorId: actor.id,
          name: run.name,
          namespace: run.namespace,
          agent: run.agent,
          requestedSecrets: [],
          requestedConnectors: ['kubernetes'],
          requestedTools: ['create AgentRun', 'follow logs'],
        })
        await saveGatewayState(state)

        return jsonResponse({ ok: true, run, agentRun, snapshot: buildSnapshot(state) }, 201)
      },
    },
  },
})

type CreateAgentRunPayload = Partial<CreateLiveAgentRunInput>

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
