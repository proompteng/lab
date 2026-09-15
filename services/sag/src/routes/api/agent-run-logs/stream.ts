import { createFileRoute } from '@tanstack/react-router'
import { streamAgentRunLogs } from '~/server/kubernetes'

export const Route = createFileRoute('/api/agent-run-logs/stream')({
  server: {
    handlers: {
      GET: async ({ request }: SagServerRouteArgs) => {
        const url = new URL(request.url)
        const namespace = url.searchParams.get('namespace') ?? 'agents'
        const name = url.searchParams.get('name') ?? ''
        const tailLines = Number(url.searchParams.get('tailLines') ?? '300')
        if (!name.trim()) return textResponse('AgentRun name is required.', 400)
        return streamAgentRunLogs(namespace, name, tailLines)
      },
    },
  },
})

const textResponse = (text: string, status = 200) =>
  new Response(`${text}\n`, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
