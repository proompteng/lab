import { createFileRoute } from '@tanstack/react-router'

import { listControlPlanePrimitiveDefinitions } from '../server/control-plane-ui-api'

export const Route = createFileRoute('/api/primitives')({
  server: {
    handlers: {
      GET: async () => listControlPlanePrimitiveDefinitions(),
    },
  },
})
