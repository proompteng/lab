import { createFileRoute } from '@tanstack/react-router'
import { resolveGrpcStatus } from '~/server/control-plane-grpc'
import { buildControlPlaneStatus } from '~/server/control-plane-status'
import { buildCachedControlPlaneStatus } from '~/server/control-plane-status-cache'
import { projectControlPlaneStatus } from '~/server/control-plane-status-projection'
import type { TorghutConsumerEvidenceResolution } from '~/server/control-plane-torghut-consumer-evidence'
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
  const resolveTorghutConsumerEvidence = resolveTorghutConsumerEvidenceForStatusRequest(request)

  try {
    const options = {
      namespace,
      grpc: await resolveGrpcStatus(),
    }
    const status = resolveTorghutConsumerEvidence
      ? await buildControlPlaneStatus(options, { resolveTorghutConsumerEvidence })
      : await buildCachedControlPlaneStatus(options)
    return okResponse(projectControlPlaneStatus(status, view))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, 500, { namespace })
  }
}

export const resolveTorghutConsumerEvidenceForStatusRequest = (
  request: Request,
): (() => Promise<TorghutConsumerEvidenceResolution>) | undefined => {
  const mode = request.headers.get('x-torghut-consumer-evidence-mode')?.trim().toLowerCase()
  if (mode !== 'omit') return undefined

  return async () => ({
    status: {
      status: 'disabled',
      endpoint: '',
      receipt_id: null,
      generated_at: null,
      fresh_until: null,
      candidate_id: null,
      dataset_snapshot_ref: null,
      max_notional: null,
      reason_codes: ['torghut_consumer_evidence_omitted_for_non_recursive_status'],
      message: 'torghut consumer evidence omitted for non-recursive Torghut carry import',
    },
  })
}
