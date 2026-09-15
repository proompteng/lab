import { createFileRoute } from '@tanstack/react-router'
import { listImplementationSpecs } from '~/server/kubernetes'

export const Route = createFileRoute('/api/implementation-specs')({
  server: {
    handlers: {
      GET: async () => jsonResponse({ ok: true, specs: await listImplementationSpecs({ namespace: 'agents' }) }),
    },
  },
})

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
