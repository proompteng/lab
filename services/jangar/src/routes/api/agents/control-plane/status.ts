import { createFileRoute } from '@tanstack/react-router'

import { buildControlPlaneStatus, type GrpcStatus } from '~/server/control-plane-status'
import { errorResponse, normalizeNamespace, okResponse } from '~/server/primitives-http'

const DEFAULT_GRPC_PORT = 50051

const resolveGrpcStatus = (): GrpcStatus => {
  const enabled = (process.env.JANGAR_GRPC_ENABLED ?? '').trim().toLowerCase()
  if (!['1', 'true', 'yes', 'on'].includes(enabled)) {
    return {
      enabled: false,
      address: '',
      status: 'disabled',
      message: 'gRPC disabled',
    }
  }

  const host = (process.env.JANGAR_GRPC_HOST ?? '').trim() || '127.0.0.1'
  const port = Number.parseInt(process.env.JANGAR_GRPC_PORT ?? '', 10) || DEFAULT_GRPC_PORT
  const address = process.env.JANGAR_GRPC_ADDRESS?.trim() || `${host}:${port}`

  return {
    enabled: true,
    address,
    status: 'healthy',
    message: '',
  }
}

export const Route = createFileRoute('/api/agents/control-plane/status')({
  server: {
    handlers: {
      GET: async ({ request }) => getControlPlaneStatus(request),
    },
  },
})

export const getControlPlaneStatus = async (request: Request, deps: { grpc?: GrpcStatus } = {}) => {
  const url = new URL(request.url)
  const namespace = normalizeNamespace(url.searchParams.get('namespace'), 'agents')

  try {
    const status = await buildControlPlaneStatus({
      namespace,
      grpc: deps.grpc ?? resolveGrpcStatus(),
    })
    return okResponse(status)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, 500, { namespace })
  }
}
