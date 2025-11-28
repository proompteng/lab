import { createFileRoute } from '@tanstack/react-router'

const modelId = 'gpt-5.1-codex-max'

const buildModelsResponse = () => ({
  object: 'list',
  data: [
    {
      id: modelId,
      object: 'model',
      owned_by: 'jangar',
      created: Math.floor(Date.now() / 1000),
      permission: [],
      root: modelId,
      parent: null,
    },
  ],
})

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
