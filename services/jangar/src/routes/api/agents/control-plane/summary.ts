import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/agents/control-plane/summary')({
  server: {
    handlers: {
      GET: async ({ request }: JangarServerRouteArgs) => {
        const { getControlPlaneSummary } = await import('@proompteng/agents/routes/api/agents/control-plane/summary')
        return getControlPlaneSummary(request)
      },
    },
  },
})
