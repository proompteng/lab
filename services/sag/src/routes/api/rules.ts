import { createFileRoute } from '@tanstack/react-router'
import { translateRuleWithCodex } from '~/server/codex-rules'
import { buildSnapshot, createRuleFromText, resolveActorFromRequest } from '~/server/gateway'
import { loadGatewayState, saveGatewayState } from '~/server/persistence'

export const Route = createFileRoute('/api/rules')({
  server: {
    handlers: {
      GET: async () => jsonResponse(buildSnapshot(await loadGatewayState())),
      POST: async ({ request }: SagServerRouteArgs) => {
        const payload = (await request.json().catch(() => null)) as { text?: string } | null
        const actor = resolveActorFromRequest(request)
        const text = payload?.text?.trim()
        if (!text || text.length < 8) {
          return jsonResponse({ ok: false, error: 'text must be at least 8 characters' }, 400)
        }

        const state = await loadGatewayState()
        const translation = await translateRuleWithCodex(text)
        const rule = createRuleFromText(state, { actorId: actor.id, text }, translation)
        await saveGatewayState(state)
        return jsonResponse({ ok: true, rule, snapshot: buildSnapshot(state) })
      },
    },
  },
})

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
