import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { streamControlPlaneEvents } from '../../../server/v1/control-plane-stream'

export const Route = createFileRoute('/v1/control-plane/stream')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => streamControlPlaneEvents(request),
    },
  },
})
