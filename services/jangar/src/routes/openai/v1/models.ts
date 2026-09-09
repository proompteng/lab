import { createFileRoute } from '@tanstack/react-router'
import { Effect } from 'effect'
import { listModels } from '~/server/models'

export const Route = createFileRoute('/openai/v1/models')({
  server: {
    handlers: {
      GET: async () => modelsHandler(),
    },
  },
})

export const modelsHandler = () =>
  Effect.runPromise(listModels).then((payload) => {
    const body = JSON.stringify(payload)
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body).toString(),
      },
    })
  })
