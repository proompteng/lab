import { createFileRoute } from '@tanstack/react-router'

import { createPrimitiveResourceForUi, listPrimitiveResourcesForUi } from '../server/control-plane-ui-api'

export const Route = createFileRoute('/api/primitives/$kind/resources')({
  server: {
    handlers: {
      GET: async ({ params, request }) => listPrimitiveResourcesForUi(params.kind, request),
      POST: async ({ params, request }) => createPrimitiveResourceForUi(params.kind, request),
    },
  },
})
