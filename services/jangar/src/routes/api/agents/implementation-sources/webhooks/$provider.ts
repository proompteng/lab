import { createFileRoute } from '@tanstack/react-router'
import { postImplementationSourceWebhookHandler } from '~/server/implementation-source-webhooks'
import { getLeaderElectionStatus } from '~/server/leader-election'

export const Route = createFileRoute('/api/agents/implementation-sources/webhooks/$provider')({
  server: {
    handlers: {
      GET: async () => new Response('Method Not Allowed', { status: 405 }),
      POST: async ({ params, request }) => {
        const leaderElection = getLeaderElectionStatus()
        if (leaderElection.enabled && leaderElection.required && !leaderElection.isLeader) {
          return new Response('Not Leader', {
            status: 503,
            headers: {
              'retry-after': '5',
            },
          })
        }
        return postImplementationSourceWebhookHandler(params.provider, request)
      },
    },
  },
})
