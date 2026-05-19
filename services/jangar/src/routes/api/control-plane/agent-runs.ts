import { createFileRoute } from '@tanstack/react-router'

import { submitAgentRunToAgentsService } from '~/server/agents-service-proxy'

type AgentRunSubmitter = typeof submitAgentRunToAgentsService

export const Route = createFileRoute('/api/control-plane/agent-runs')({
  server: {
    handlers: {
      POST: async ({ request }: JangarServerRouteArgs) => postControlPlaneAgentRun(request),
      GET: async () => new Response('Method Not Allowed', { status: 405 }),
    },
  },
})

const jsonResponse = (payload: unknown, status = 200) => {
  const body = JSON.stringify(payload)
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body).toString(),
    },
  })
}

const readJsonPayload = async (request: Request) => {
  const payload = (await request.json().catch(() => null)) as unknown
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('request body must be a JSON object')
  }
  return payload as Record<string, unknown>
}

export const postControlPlaneAgentRun = async (request: Request, deps: { submitAgentRun?: AgentRunSubmitter } = {}) => {
  const deliveryId = request.headers.get('idempotency-key')?.trim()
  if (!deliveryId) {
    return jsonResponse({ ok: false, error: 'idempotency-key header is required' }, 400)
  }

  try {
    const payload = await readJsonPayload(request)
    const url = new URL(request.url)
    const dryRun = url.searchParams.get('dryRun')
    const result = await (deps.submitAgentRun ?? submitAgentRunToAgentsService)({
      deliveryId,
      dryRun,
      payload,
    })

    if (result.ok) {
      return jsonResponse(result.body, result.status)
    }

    return jsonResponse(
      result.body ?? {
        ok: false,
        error: result.error ?? 'Agents service unavailable',
      },
      result.status > 0 ? result.status : 502,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return jsonResponse({ ok: false, error: message }, 400)
  }
}
