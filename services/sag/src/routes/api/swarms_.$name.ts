import { createFileRoute } from '@tanstack/react-router'
import { getSwarm } from '~/server/kubernetes'

export const Route = createFileRoute('/api/swarms_/$name')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const swarm = await getSwarm({ namespace: 'agents', name: params.name })
        return swarm ? jsonResponse({ ok: true, swarm }) : jsonResponse({ ok: false, error: 'Swarm not found' }, 404)
      },
    },
  },
})

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
