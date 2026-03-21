import { createFileRoute } from '@tanstack/react-router'
import { resolveGrpcStatus } from '~/server/control-plane-grpc'
import { buildControlPlaneStatus } from '~/server/control-plane-status'
import { errorResponse, normalizeNamespace, okResponse } from '~/server/primitives-http'
import { getQuantHealthHandler } from '../../torghut/trading/control-plane/quant/health'

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
  const account = url.searchParams.get('account')?.trim() ?? ''
  const window = url.searchParams.get('window')?.trim() ?? ''

  try {
    const status = await buildControlPlaneStatus({
      namespace,
      grpc: await resolveGrpcStatus(),
    })
    if (!account || !window) return okResponse(status)

    const quantUrl = new URL('/api/torghut/trading/control-plane/quant/health', url.origin)
    quantUrl.searchParams.set('account', account)
    quantUrl.searchParams.set('window', window)
    const quantResponse = await getQuantHealthHandler(
      new Request(quantUrl.toString(), {
        headers: request.headers,
      }),
    )
    const quantPayload = (await quantResponse.json().catch(() => null)) as Record<string, unknown> | null
    return okResponse({
      ...status,
      quant_evidence: quantPayload,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, 500, { namespace })
  }
}
