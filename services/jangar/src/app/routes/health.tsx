import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/health')({
  loader: () => {
    console.info('[jangar] GET /health')
    return { status: 'ok' as const, service: 'jangar-ui' }
  },
  component: Health,
})

function Health() {
  const data = Route.useLoaderData()
  return <pre className="text-sm leading-6">{JSON.stringify(data, null, 2)}</pre>
}
