import { createFileRoute } from '@tanstack/react-router'
import { buildSnapshot, createTaskFromText, resolveActorFromRequest } from '~/server/gateway'
import { listLiveAgentRuns } from '~/server/kubernetes'
import { loadGatewayState, readWorkflowContext, saveGatewayState } from '~/server/persistence'

export const Route = createFileRoute('/api/tasks')({
  server: {
    handlers: {
      GET: async () => jsonResponse(buildSnapshot(await loadGatewayState())),
      POST: async ({ request }: SagServerRouteArgs) => {
        const payload = (await request.json().catch(() => null)) as { text?: string } | null
        const text = payload?.text?.trim()
        if (!text || text.length < 8) {
          return jsonResponse({ ok: false, error: 'text must be at least 8 characters' }, 400)
        }

        const actor = resolveActorFromRequest(request)
        const state = await loadGatewayState()
        const [workflowContext, liveAgentRuns] = await Promise.all([readWorkflowContext(), listLiveAgentRuns(20)])
        const task = createTaskFromText(
          state,
          {
            actorId: actor.id,
            text,
          },
          {
            ...workflowContext,
            liveAgentRuns,
          },
        )
        await saveGatewayState(state)
        return jsonResponse({ ok: true, task, snapshot: buildSnapshot(state) })
      },
    },
  },
})

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
