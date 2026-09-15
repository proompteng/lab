import { createFileRoute } from '@tanstack/react-router'
import { listSwarms } from '~/server/kubernetes'

export const Route = createFileRoute('/api/swarms')({
  server: {
    handlers: {
      GET: async () => jsonResponse({ ok: true, swarms: await listSwarms({ namespace: 'agents' }) }),
    },
  },
})

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
