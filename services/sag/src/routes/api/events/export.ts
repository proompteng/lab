import { createFileRoute } from '@tanstack/react-router'
import { exportAuditEvents } from '~/server/gateway'
import { loadGatewayState } from '~/server/persistence'

export const Route = createFileRoute('/api/events/export')({
  server: {
    handlers: {
      GET: async () =>
        new Response(`${exportAuditEvents(await loadGatewayState())}\n`, {
          headers: {
            'content-type': 'application/x-ndjson; charset=utf-8',
            'cache-control': 'no-store',
          },
        }),
    },
  },
})
