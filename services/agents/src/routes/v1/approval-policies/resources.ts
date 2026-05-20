import { createFileRoute, type AgentsServerRouteArgs } from '../../../server/server-route'
import { getFixedKindResource } from '../resource-route-helpers'

export const Route = createFileRoute('/v1/approval-policies/resources')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => getApprovalPolicyResource(request),
    },
  },
})

export const getApprovalPolicyResource = (request: Request, deps: Parameters<typeof getFixedKindResource>[2] = {}) =>
  getFixedKindResource('ApprovalPolicy', request, deps)
