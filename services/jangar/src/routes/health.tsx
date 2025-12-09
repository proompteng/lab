import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/health')({
  loader: () => ({ status: 'ok', service: 'jangar' as const }),
  component: Health,
})

function Health() {
  const data = Route.useLoaderData()
  return (
    <pre className="p-4 text-sm leading-6 bg-slate-900 text-slate-100 rounded-lg border border-slate-800">
      {JSON.stringify(data, null, 2)}
    </pre>
  )
}
