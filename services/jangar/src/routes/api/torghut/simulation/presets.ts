import { createFileRoute } from '@tanstack/react-router'

import { listTorghutSimulationPresets } from '~/server/torghut-simulation-control-plane'

export const Route = createFileRoute('/api/torghut/simulation/presets')({
  server: {
    handlers: {
      GET: async () => listSimulationPresetsHandler(),
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

export const listSimulationPresetsHandler = async () => {
  const presets = await listTorghutSimulationPresets()
  return jsonResponse({ ok: true, presets }, 200)
}
