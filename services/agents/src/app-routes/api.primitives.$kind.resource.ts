import { createFileRoute } from '@tanstack/react-router'

import { getPrimitiveResourceForUi } from '../server/control-plane-ui-api'

export const Route = createFileRoute('/api/primitives/$kind/resource')({
  server: {
    handlers: {
      GET: async ({ params, request }) => getPrimitiveResourceForUi(params.kind, request),
    },
  },
})
