import { createFileRoute, type AgentsServerRouteArgs } from '../../../../../server/server-route'

import { postImplementationSourceWebhookHandler } from '../../../../../server/implementation-source-webhooks'
import { requireLeaderForMutationHttp } from '../../../../../server/leader-election'

export const Route = createFileRoute('/api/agents/implementation-sources/webhooks/$provider')({
  server: {
    handlers: {
      GET: async () => new Response('Method Not Allowed', { status: 405 }),
      POST: async ({ params, request }: AgentsServerRouteArgs) => {
        const leaderResponse = requireLeaderForMutationHttp()
        if (leaderResponse) return leaderResponse
        return postImplementationSourceWebhookHandler(params.provider ?? '', request)
      },
    },
  },
})
