import { createFileRoute } from '@tanstack/react-router'

import { getTorghutDecisionRun, isTorghutDecisionEngineEnabled } from '~/server/torghut-decision-engine'

export const Route = createFileRoute('/api/torghut/decision-engine/runs/$id')({
  server: {
    handlers: {
      GET: async ({ params }) => getDecisionRunStatus(params.id),
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

export const getDecisionRunStatus = async (runIdRaw: string) => {
  if (!(await isTorghutDecisionEngineEnabled())) {
    return jsonResponse({ ok: false, message: 'torghut decision engine disabled' }, 503)
  }

  const runId = runIdRaw.trim()
  if (!runId) {
    return jsonResponse({ ok: false, message: 'run id is required' }, 400)
  }

  const run = getTorghutDecisionRun(runId)
  if (!run) {
    return jsonResponse({ ok: false, message: 'run not found' }, 404)
  }

  return jsonResponse({
    ok: true,
    run: {
      run_id: run.runId,
      request_id: run.requestId,
      symbol: run.symbol,
      strategy_id: run.strategyId,
      state: run.state,
      created_at: run.createdAt,
      updated_at: run.updatedAt,
      started_at: run.startedAt,
      completed_at: run.completedAt,
      final_payload: run.finalPayload,
      error: run.error,
    },
  })
}
