import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { getFixedKindResource } from '../resource-route-helpers'

export const Route = createFileRoute('/v1/budgets/resources')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => getBudgetResource(request),
    },
  },
})

export const getBudgetResource = (request: Request, deps: Parameters<typeof getFixedKindResource>[2] = {}) =>
  getFixedKindResource('Budget', request, deps)
