import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { buildExecutionTrustResponse } from '../../../server/v1/control-plane-execution-trust'

export const Route = createFileRoute('/v1/control-plane/execution-trust')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => buildExecutionTrustResponse(request),
    },
  },
})

export { buildExecutionTrustResponse }
