import { createFileRoute } from '@tanstack/react-router'

const modelsResponse = {
  object: 'list',
  data: [
    {
      id: 'meta-orchestrator',
      object: 'model',
      owned_by: 'jangar',
      created: Math.floor(Date.now() / 1000),
    },
  ],
}

export const Route = createFileRoute('/openai/v1/models')({
  server: {
    handlers: {
      GET: async () => {
        const body = JSON.stringify(modelsResponse)
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
