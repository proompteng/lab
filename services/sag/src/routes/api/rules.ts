import { createFileRoute } from '@tanstack/react-router'
import { buildSnapshot, createRuleFromText, type ActorId } from '~/server/gateway'
import { loadGatewayState, saveGatewayState } from '~/server/persistence'

export const Route = createFileRoute('/api/rules')({
  server: {
    handlers: {
      GET: async () => jsonResponse(buildSnapshot(await loadGatewayState())),
      POST: async ({ request }: SagServerRouteArgs) => {
        const payload = (await request.json().catch(() => null)) as { actorId?: string; text?: string } | null
        const actorId = isActorId(payload?.actorId) ? payload.actorId : null
        const text = payload?.text?.trim()
        if (!actorId) {
          return jsonResponse({ ok: false, error: 'actorId must be greg, ops, or audit' }, 400)
        }
        if (!text || text.length < 8) {
          return jsonResponse({ ok: false, error: 'text must be at least 8 characters' }, 400)
        }

        const state = await loadGatewayState()
        const rule = createRuleFromText(state, { actorId, text })
        await saveGatewayState(state)
        return jsonResponse({ ok: true, rule, snapshot: buildSnapshot(state) })
      },
    },
  },
})

const isActorId = (value: unknown): value is ActorId => value === 'greg' || value === 'ops' || value === 'audit'

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
