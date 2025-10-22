import { createServerFileRoute } from '@tanstack/react-start/server'
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

export const ServerRoute = createServerFileRoute('/trpc').methods({
  GET: ({ request }) => handleRequest(request),
  POST: ({ request }) => handleRequest(request),
})
