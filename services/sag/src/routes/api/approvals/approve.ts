import { createFileRoute } from '@tanstack/react-router'
import { approveAction, buildSnapshot, resolveActorFromRequest } from '~/server/gateway'
import { loadGatewayState, saveGatewayState } from '~/server/persistence'

export const Route = createFileRoute('/api/approvals/approve')({
  server: {
    handlers: {
      POST: async ({ request }: SagServerRouteArgs) => {
        const payload = (await request.json().catch(() => null)) as { approvalId?: string } | null
        const actor = resolveActorFromRequest(request)
        const state = await loadGatewayState()
        const approvalId = payload?.approvalId ?? state.approvals.find((approval) => approval.status === 'pending')?.id
        if (!approvalId) {
          return jsonResponse({ ok: false, message: 'No approval is waiting', snapshot: buildSnapshot(state) })
        }

        const result = approveAction(state, { actorId: actor.id, approvalId })
        await saveGatewayState(state)
        return jsonResponse({ ...result, snapshot: buildSnapshot(state) })
      },
      GET: async () => jsonResponse({ ok: false, error: 'POST required' }, 405),
    },
  },
})

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
