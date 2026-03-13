import { createFileRoute } from '@tanstack/react-router'

import {
  listTorghutSimulationRuns,
  parseTorghutSimulationRunRequest,
  submitTorghutSimulationRun,
} from '~/server/torghut-simulation-control-plane'

export const Route = createFileRoute('/api/torghut/simulation/runs')({
  server: {
    handlers: {
      GET: async ({ request }) => listSimulationRunsHandler(request),
      POST: async ({ request }) => submitSimulationRunHandler(request),
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

export const listSimulationRunsHandler = async (request: Request) => {
  const url = new URL(request.url)
  const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '20', 10)
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 20
  const runs = await listTorghutSimulationRuns(limit)
  return jsonResponse({ ok: true, runs }, 200)
}

export const submitSimulationRunHandler = async (request: Request) => {
  const payload: unknown = await request.json().catch(() => null)
  const parsed = parseTorghutSimulationRunRequest(payload)
  if (!parsed.ok) {
    return jsonResponse({ ok: false, message: parsed.message }, 400)
  }

  try {
    const submittedBy = request.headers.get('x-forwarded-user') ?? request.headers.get('x-user') ?? null
    const result = await submitTorghutSimulationRun({
      ...parsed.value,
      submittedBy,
    })
    return jsonResponse(
      {
        ok: true,
        accepted: true,
        idempotent: result.idempotent,
        run: result.run,
        status_url: `/api/torghut/simulation/runs/${encodeURIComponent(result.run.runId)}`,
        stream_url: `/api/torghut/simulation/stream?run_id=${encodeURIComponent(result.run.runId)}`,
        artifacts_url: `/api/torghut/simulation/artifacts?run_id=${encodeURIComponent(result.run.runId)}`,
      },
      202,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'failed to submit Torghut simulation run'
    return jsonResponse({ ok: false, message }, 500)
  }
}
