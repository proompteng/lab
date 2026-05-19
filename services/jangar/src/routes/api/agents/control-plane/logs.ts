import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/agents/control-plane/logs')({
  server: {
    handlers: {
      GET: async ({ request }: JangarServerRouteArgs) => {
        const { getAgentRunLogs } = await import('@proompteng/agents/routes/api/agents/control-plane/logs')
        return getAgentRunLogs(request)
      },
    },
  },
})
