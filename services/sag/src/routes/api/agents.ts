import { createFileRoute } from '@tanstack/react-router'
import { listAgents } from '~/server/kubernetes'

export const Route = createFileRoute('/api/agents')({
  server: {
    handlers: {
      GET: async () => jsonResponse({ ok: true, agents: await listAgents() }),
    },
  },
})

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
