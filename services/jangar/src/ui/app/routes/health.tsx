import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/health')({
  loader: () => ({ status: 'ok' as const, service: 'jangar-ui' }),
  component: Health,
})

function Health() {
  const data = Route.useLoaderData()
  return (
    <pre aria-label="health" style={{ fontSize: 14, lineHeight: 1.4 }}>
      {JSON.stringify(data, null, 2)}
    </pre>
  )
}
