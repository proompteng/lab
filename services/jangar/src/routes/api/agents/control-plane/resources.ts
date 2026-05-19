import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/agents/control-plane/resources')({
  server: {
    handlers: {
      GET: async ({ request }: JangarServerRouteArgs) => {
        const { listPrimitiveResources } = await import('@proompteng/agents/routes/api/agents/control-plane/resources')
        return listPrimitiveResources(request)
      },
    },
  },
})
