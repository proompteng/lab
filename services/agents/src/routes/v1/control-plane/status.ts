import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { buildControlPlaneStatusResponse, getControlPlaneStatus } from '../../../server/v1/control-plane-status'

export const Route = createFileRoute('/v1/control-plane/status')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => buildControlPlaneStatusResponse(request),
    },
  },
})

export { buildControlPlaneStatusResponse, getControlPlaneStatus }
