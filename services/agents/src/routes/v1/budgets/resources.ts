import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { getTypedResourceHandler } from '../../../server/v1/typed-resources'

export const Route = createFileRoute('/v1/budgets/resources')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => getBudgetResource(request),
    },
  },
})

export const getBudgetResource = (request: Request, deps: Parameters<typeof getTypedResourceHandler>[2] = {}) =>
  getTypedResourceHandler('Budget', request, deps)
