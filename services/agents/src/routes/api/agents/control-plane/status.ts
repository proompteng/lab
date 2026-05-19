import { createFileRoute, type AgentsServerRouteArgs } from '../../../../server/server-route'

import {
  getAgentsControlPlaneStatus,
  type AgentsControlPlaneStatusDependencies,
} from '../../../../server/control-plane-status'
import { errorResponse, okResponse } from '../../../../server/http'
import { normalizeNamespace } from '../../../../server/primitives'

export const Route = createFileRoute('/api/agents/control-plane/status')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => buildControlPlaneStatusResponse(request),
    },
  },
})

export const buildControlPlaneStatusResponse = async (
  request: Request,
  deps: AgentsControlPlaneStatusDependencies = {},
) => {
  const url = new URL(request.url)
  const namespace = normalizeNamespace(url.searchParams.get('namespace'), 'agents')

  try {
    const status = await getAgentsControlPlaneStatus(
      {
        namespace,
        service: 'agents',
      },
      deps,
    )
    return okResponse(status)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, 500, { namespace })
  }
}

export const getControlPlaneStatus = buildControlPlaneStatusResponse
