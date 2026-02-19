import { createFileRoute } from '@tanstack/react-router'

import {
  isTorghutDecisionEngineEnabled,
  parseDecisionEngineRequest,
  submitTorghutDecisionRun,
} from '~/server/torghut-decision-engine'

export const Route = createFileRoute('/api/torghut/decision-engine/runs')({
  server: {
    handlers: {
      POST: async ({ request }) => submitDecisionRun(request),
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

export const submitDecisionRun = async (request: Request) => {
  if (!isTorghutDecisionEngineEnabled()) {
    return jsonResponse({ ok: false, message: 'torghut decision engine disabled' }, 503)
  }

  const payload: unknown = await request.json().catch(() => null)
  const parsed = parseDecisionEngineRequest(payload)
  if (!parsed.ok) {
    return jsonResponse({ ok: false, message: parsed.message }, 400)
  }

  const submitted = submitTorghutDecisionRun(parsed.value)
  const run = submitted.run

  return jsonResponse(
    {
      ok: true,
      accepted: true,
      idempotent: submitted.idempotent,
      run_id: run.runId,
      request_id: run.requestId,
      state: run.state,
      status_url: `/api/torghut/decision-engine/runs/${encodeURIComponent(run.runId)}`,
      stream_url: '/api/torghut/decision-engine/stream',
    },
    202,
  )
}
