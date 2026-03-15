import { createFileRoute } from '@tanstack/react-router'

import { getTorghutSimulationCampaign } from '~/server/torghut-simulation-control-plane'

export const Route = createFileRoute('/api/torghut/simulation/campaigns/$id')({
  server: {
    handlers: {
      GET: async ({ params }) => getSimulationCampaignHandler(params.id),
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

export const getSimulationCampaignHandler = async (id: string) => {
  const result = await getTorghutSimulationCampaign(id)
  if (!result) {
    return jsonResponse({ ok: false, message: 'simulation campaign not found' }, 404)
  }
  return jsonResponse({ ok: true, campaign: result.campaign, runs: result.runs }, 200)
}
