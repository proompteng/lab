import { createFileRoute } from '@tanstack/react-router'
import { requireLeaderForMutationHttp } from '~/server/leader-election'

import {
  listTorghutSimulationCampaigns,
  parseTorghutSimulationCampaignRequest,
  submitTorghutSimulationCampaign,
} from '~/server/torghut-simulation-control-plane'

export const Route = createFileRoute('/api/torghut/simulation/campaigns')({
  server: {
    handlers: {
      GET: async ({ request }: JangarServerRouteArgs) => listSimulationCampaignsHandler(request),
      POST: async ({ request }: JangarServerRouteArgs) => submitSimulationCampaignHandler(request),
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

export const listSimulationCampaignsHandler = async (request: Request) => {
  const url = new URL(request.url)
  const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '20', 10)
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 20
  const campaigns = await listTorghutSimulationCampaigns(limit)
  return jsonResponse({ ok: true, campaigns }, 200)
}

export const submitSimulationCampaignHandler = async (request: Request) => {
  const leaderResponse = requireLeaderForMutationHttp()
  if (leaderResponse) return leaderResponse
  const payload: unknown = await request.json().catch(() => null)
  const parsed = parseTorghutSimulationCampaignRequest(payload)
  if (!parsed.ok) {
    return jsonResponse({ ok: false, message: parsed.message }, 400)
  }

  try {
    const submittedBy = request.headers.get('x-forwarded-user') ?? request.headers.get('x-user') ?? null
    const result = await submitTorghutSimulationCampaign({
      ...parsed.value,
      submittedBy,
    })
    return jsonResponse(
      {
        ok: true,
        accepted: true,
        campaign: result.campaign,
        runs: result.runs,
        status_url: `/api/torghut/simulation/campaigns/${encodeURIComponent(result.campaign.campaignId)}`,
      },
      202,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'failed to submit Torghut simulation campaign'
    return jsonResponse({ ok: false, message }, 500)
  }
}
