import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { getControlPlaneSummary } from '../../../server/v1/control-plane-summary'

export const Route = createFileRoute('/v1/control-plane/summary')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => getControlPlaneSummary(request),
    },
  },
})
