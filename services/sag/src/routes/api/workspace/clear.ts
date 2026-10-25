import { createFileRoute } from '@tanstack/react-router'
import { buildSnapshot } from '~/server/gateway'
import { resetPersistentGatewayState } from '~/server/persistence'

export const Route = createFileRoute('/api/workspace/clear')({
  server: {
    handlers: {
      POST: async () => {
        const state = await resetPersistentGatewayState()
        return jsonResponse({ ok: true, message: 'Run state cleared', snapshot: buildSnapshot(state) })
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
