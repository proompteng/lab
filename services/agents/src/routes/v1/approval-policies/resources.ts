import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { getTypedResourceHandler } from '../../../server/v1/typed-resources'

export const Route = createFileRoute('/v1/approval-policies/resources')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => getApprovalPolicyResource(request),
    },
  },
})

export const getApprovalPolicyResource = (request: Request, deps: Parameters<typeof getTypedResourceHandler>[2] = {}) =>
  getTypedResourceHandler('ApprovalPolicy', request, deps)
