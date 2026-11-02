import { createFileRoute } from '@tanstack/react-router'

import { listTorghutSimulationArtifacts } from '~/server/torghut-simulation-control-plane'

export const Route = createFileRoute('/api/torghut/simulation/artifacts')({
  server: {
    handlers: {
      GET: async ({ request }: JangarServerRouteArgs) => listSimulationArtifactsHandler(request),
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

export const listSimulationArtifactsHandler = async (request: Request) => {
  const url = new URL(request.url)
  const runId = url.searchParams.get('run_id')?.trim()
  if (!runId) {
    return jsonResponse({ ok: false, message: 'run_id is required' }, 400)
  }
  const artifacts = await listTorghutSimulationArtifacts(runId)
  return jsonResponse({ ok: true, artifacts }, 200)
}
