import { createFileRoute } from '@tanstack/react-router'
import { buildSnapshot } from '~/server/gateway'
import { loadGatewayState } from '~/server/persistence'

export const Route = createFileRoute('/api/snapshot')({
  server: {
    handlers: {
      GET: async () => jsonResponse(buildSnapshot(await loadGatewayState())),
    },
  },
})

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
