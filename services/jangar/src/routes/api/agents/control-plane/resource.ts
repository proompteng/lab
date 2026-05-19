import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/agents/control-plane/resource')({
  server: {
    handlers: {
      DELETE: async ({ request }: JangarServerRouteArgs) => {
        const { deletePrimitiveResource } = await import('@proompteng/agents/routes/api/agents/control-plane/resource')
        return deletePrimitiveResource(request)
      },
      GET: async ({ request }: JangarServerRouteArgs) => {
        const { getPrimitiveResource } = await import('@proompteng/agents/routes/api/agents/control-plane/resource')
        return getPrimitiveResource(request)
      },
      POST: async ({ request }: JangarServerRouteArgs) => {
        const { postPrimitiveResource } = await import('@proompteng/agents/routes/api/agents/control-plane/resource')
        return postPrimitiveResource(request)
      },
    },
  },
})
