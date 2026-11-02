import { createFileRoute, type AgentsServerRouteArgs } from '../../../../server/server-route'

import { postImplementationSourceWebhookHandler } from '../../../../server/implementation-source-webhooks'
import { requireLeaderForMutationHttp } from '../../../../server/leader-election'

const froussardOwnsPublicWebhooks = () => {
  const value = process.env.AGENTS_IMPLEMENTATION_SOURCE_WEBHOOKS_GONE?.trim().toLowerCase()
  return value === 'true' || value === '1'
}

const gone = (provider: string) => {
  const successor = `https://froussard.proompteng.ai/webhooks/${encodeURIComponent(provider)}`
  return Response.json(
    {
      error: 'gone',
      message: 'Public webhook ingestion is owned by Froussard.',
      successor,
    },
    {
      status: 410,
      headers: {
        'cache-control': 'no-store',
        deprecation: 'true',
        link: `<${successor}>; rel="successor-version"`,
      },
    },
  )
}

export const Route = createFileRoute('/v1/implementation-sources/webhooks/$provider')({
  server: {
    handlers: {
      GET: async () => new Response('Method Not Allowed', { status: 405 }),
      POST: async ({ params, request }: AgentsServerRouteArgs) => {
        if (froussardOwnsPublicWebhooks()) return gone(params.provider ?? 'unknown')
        const leaderResponse = requireLeaderForMutationHttp()
        if (leaderResponse) return leaderResponse
        return postImplementationSourceWebhookHandler(params.provider ?? '', request)
      },
    },
  },
})

export const __test__ = { froussardOwnsPublicWebhooks }
