import { createFileRoute } from '@tanstack/react-router'

import { buildModelsResponse } from '~/lib/models'

const logRouteHit = (path: string) => {
  console.info(`[jangar] ${path}`)
}

export const Route = createFileRoute('/openai/v1/models')({
  server: {
    handlers: {
      GET: async () => {
        logRouteHit('GET /openai/v1/models')

        const body = JSON.stringify(buildModelsResponse())
        return new Response(body, {
          headers: {
            'content-type': 'application/json',
            'content-length': String(body.length),
          },
        })
      },
    },
  },
})
