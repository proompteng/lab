import { createFileRoute } from '@tanstack/react-router'
import { resolveGrpcStatus } from '~/server/control-plane-grpc'
import { buildCachedControlPlaneStatus } from '~/server/control-plane-status-cache'
import { projectControlPlaneStatus } from '~/server/control-plane-status-projection'
import { errorResponse, normalizeNamespace, okResponse } from '~/server/primitives-http'

export const Route = createFileRoute('/api/agents/control-plane/status')({
  server: {
    handlers: {
      GET: async ({ request }: JangarServerRouteArgs) => getControlPlaneStatus(request),
    },
  },
})

export const getControlPlaneStatus = async (request: Request) => {
  const url = new URL(request.url)
  const namespace = normalizeNamespace(url.searchParams.get('namespace'), 'agents')
  const view = url.searchParams.get('view') ?? url.searchParams.get('projection')

  try {
    const status = await buildCachedControlPlaneStatus({
      namespace,
      grpc: await resolveGrpcStatus(),
    })
    return okResponse(projectControlPlaneStatus(status, view))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, 500, { namespace })
  }
}
