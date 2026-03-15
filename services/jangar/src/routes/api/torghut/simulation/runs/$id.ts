import { createFileRoute } from '@tanstack/react-router'
import { requireLeaderForMutationHttp } from '~/server/leader-election'

import { cancelTorghutSimulationRun, syncTorghutSimulationRun } from '~/server/torghut-simulation-control-plane'

export const Route = createFileRoute('/api/torghut/simulation/runs/$id')({
  server: {
    handlers: {
      GET: async ({ params }) => getSimulationRunHandler(params.id),
      DELETE: async ({ params }) => cancelSimulationRunHandler(params.id),
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

export const getSimulationRunHandler = async (id: string) => {
  const run = await syncTorghutSimulationRun(id)
  if (!run) {
    return jsonResponse({ ok: false, message: 'simulation run not found' }, 404)
  }
  return jsonResponse({ ok: true, run }, 200)
}

export const cancelSimulationRunHandler = async (id: string) => {
  const leaderResponse = requireLeaderForMutationHttp()
  if (leaderResponse) return leaderResponse
  const run = await cancelTorghutSimulationRun(id)
  if (!run) {
    return jsonResponse({ ok: false, message: 'simulation run not found' }, 404)
  }
  return jsonResponse({ ok: true, run }, 200)
}
