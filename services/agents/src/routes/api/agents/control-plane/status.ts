import { createFileRoute, type AgentsServerRouteArgs } from '../../../../server/server-route'

import { buildAgentsControlPlaneStatus } from '../../../../server/control-plane-status'
import { resolveGrpcStatus } from '../../../../server/control-plane-grpc'
import { errorResponse, okResponse } from '../../../../server/http'
import { normalizeNamespace } from '../../../../server/primitives'

export const Route = createFileRoute('/api/agents/control-plane/status')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => getControlPlaneStatus(request),
    },
  },
})

export const getControlPlaneStatus = async (request: Request) => {
  const url = new URL(request.url)
  const namespace = normalizeNamespace(url.searchParams.get('namespace'), 'agents')

  try {
    const status = buildAgentsControlPlaneStatus({
      namespace,
      service: 'agents',
      grpc: await resolveGrpcStatus(),
    })
    return okResponse(status)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, 500, { namespace })
  }
}
