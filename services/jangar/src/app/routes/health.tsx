import { createFileRoute } from '@tanstack/react-router'

const payload = { status: 'ok' as const, service: 'jangar-ui' as const }

export const Route = createFileRoute('/health')({
  loader: () => {
    console.info('[jangar] GET /health')
    return payload
  },
  server: {
    handlers: {
      GET: async () =>
        new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }),
      HEAD: async () => new Response(null, { status: 200 }),
    },
  },
  component: Health,
})

function Health() {
  const data = Route.useLoaderData()
  return <pre className="text-sm leading-6">{JSON.stringify(data, null, 2)}</pre>
}
