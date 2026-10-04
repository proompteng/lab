import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { listPrimitiveEvents } from '../../../server/v1/control-plane-events'

export const Route = createFileRoute('/v1/control-plane/events')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => listPrimitiveEvents(request),
    },
  },
})
