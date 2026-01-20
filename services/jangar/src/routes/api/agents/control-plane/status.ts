import { createFileRoute } from '@tanstack/react-router'
import { resolveGrpcStatus } from '~/server/control-plane-grpc'
import { buildControlPlaneStatus } from '~/server/control-plane-status'
import { errorResponse, normalizeNamespace, okResponse } from '~/server/primitives-http'

export const Route = createFileRoute('/api/agents/control-plane/status')({
  server: {
    handlers: {
      GET: async ({ request }) => getControlPlaneStatus(request),
    },
  },
})

export const getControlPlaneStatus = async (request: Request) => {
  const url = new URL(request.url)
  const namespace = normalizeNamespace(url.searchParams.get('namespace'), 'agents')

  try {
    const status = await buildControlPlaneStatus({
      namespace,
      grpc: resolveGrpcStatus(),
    })
    return okResponse(status)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, 500, { namespace })
  }
}
