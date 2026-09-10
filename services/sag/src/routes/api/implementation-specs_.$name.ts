import { createFileRoute } from '@tanstack/react-router'
import { getImplementationSpec } from '~/server/kubernetes'

export const Route = createFileRoute('/api/implementation-specs_/$name')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const spec = await getImplementationSpec({ namespace: 'agents', name: params.name })
        return spec ? jsonResponse({ ok: true, spec }) : jsonResponse({ ok: false, error: 'Spec not found' }, 404)
      },
    },
  },
})

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
