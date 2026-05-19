import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/agents/control-plane/events')({
  server: {
    handlers: {
      GET: async ({ request }: JangarServerRouteArgs) => {
        const { listPrimitiveEvents } = await import('@proompteng/agents/routes/api/agents/control-plane/events')
        return listPrimitiveEvents(request)
      },
    },
  },
})
