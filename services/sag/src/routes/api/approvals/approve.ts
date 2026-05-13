import { createFileRoute } from '@tanstack/react-router'
import { approveAction, buildSnapshot, type ActorId } from '~/server/gateway'
import { loadGatewayState, saveGatewayState } from '~/server/persistence'

export const Route = createFileRoute('/api/approvals/approve')({
  server: {
    handlers: {
      POST: async ({ request }: SagServerRouteArgs) => {
        const payload = (await request.json().catch(() => null)) as { actorId?: string; approvalId?: string } | null
        const actorId = isActorId(payload?.actorId) ? payload.actorId : null
        if (!actorId) {
          return jsonResponse({ ok: false, error: 'actorId must be greg, ops, or audit' }, 400)
        }

        const state = await loadGatewayState()
        const approvalId = payload?.approvalId ?? state.approvals.find((approval) => approval.status === 'pending')?.id
        if (!approvalId) {
          return jsonResponse({ ok: false, message: 'No approval is waiting', snapshot: buildSnapshot(state) })
        }

        const result = approveAction(state, { actorId, approvalId })
        await saveGatewayState(state)
        return jsonResponse({ ...result, snapshot: buildSnapshot(state) })
      },
      GET: async () => jsonResponse({ ok: false, error: 'POST required' }, 405),
    },
  },
})

const isActorId = (value: unknown): value is ActorId => value === 'greg' || value === 'ops' || value === 'audit'

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
