import { createFileRoute } from '@tanstack/react-router'
import { delegateAgentsRuntimeRequest } from '../../../server/start-runtime'

export const Route = createFileRoute('/mcp/relay/$target')({
  server: {
    handlers: {
      POST: ({ request }) => delegateAgentsRuntimeRequest(request),
    },
  },
})
