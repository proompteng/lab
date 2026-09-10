import { createFileRoute } from '@tanstack/react-router'

import { delegateAgentsRuntimeRequest } from '../server/start-runtime'

export const Route = createFileRoute('/metrics')({
  server: {
    handlers: {
      GET: async ({ request }) => delegateAgentsRuntimeRequest(request),
    },
  },
})
