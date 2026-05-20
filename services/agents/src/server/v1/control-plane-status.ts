import { getAgentsControlPlaneStatus, type AgentsControlPlaneStatusDependencies } from '../control-plane-status'
import { errorResponse, okResponse } from '../http'
import { normalizeNamespace } from '../primitives'

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
