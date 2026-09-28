import { createFileRoute } from '@tanstack/react-router'

import { delegateAgentsRuntimeRequest } from '../server/start-runtime'

export const Route = createFileRoute('/mcp')({
  server: {
    handlers: {
      GET: async ({ request }) => delegateAgentsRuntimeRequest(request),
      POST: async ({ request }) => delegateAgentsRuntimeRequest(request),
    },
  },
})
