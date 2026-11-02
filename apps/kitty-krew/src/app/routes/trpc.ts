import { createFileRoute } from '@tanstack/react-router'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { createContext } from '~/server/context'
import { appRouter } from '~/server/routers/_app'

const handleRequest = (request: Request) =>
  fetchRequestHandler({
    endpoint: '/trpc',
    req: request,
    router: appRouter,
    createContext,
  })

export const Route = createFileRoute('/trpc')({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => handleRequest(request),
      POST: ({ request }: { request: Request }) => handleRequest(request),
    },
  },
})
