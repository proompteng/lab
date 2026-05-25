import { createFileRoute } from '@tanstack/react-router'

import { delegateAgentsRuntimeRequest } from '../server/start-runtime'

export const Route = createFileRoute('/health')({
  server: {
    handlers: {
      GET: async ({ request }) => delegateAgentsRuntimeRequest(request),
    },
  },
})
