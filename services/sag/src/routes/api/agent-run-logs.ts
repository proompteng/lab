import { createFileRoute } from '@tanstack/react-router'
import { readAgentRunLogs } from '~/server/kubernetes'

export const Route = createFileRoute('/api/agent-run-logs')({
  server: {
    handlers: {
      GET: async ({ request }: SagServerRouteArgs) => {
        const url = new URL(request.url)
        const namespace = url.searchParams.get('namespace') ?? 'agents'
        const name = url.searchParams.get('name') ?? ''
        const tailLines = Number(url.searchParams.get('tailLines') ?? '300')
        if (!name.trim()) return jsonResponse({ ok: false, error: 'AgentRun name is required' }, 400)
        return jsonResponse({ ok: true, ...(await readAgentRunLogs(namespace, name, tailLines)) })
      },
    },
  },
})

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
