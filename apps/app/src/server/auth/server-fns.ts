import { createMiddleware, createServerFn } from '@tanstack/react-start'

import type { SessionUser } from './types'

const requestMiddleware = createMiddleware().server(async ({ request, next }) => {
  return await next({ context: { request } })
})

export const getCurrentUserServerFn = createServerFn({ method: 'GET' })
  .middleware([requestMiddleware])
  .handler(async ({ context }): Promise<SessionUser | null> => {
    const { getCurrentUser } = await import('./auth.server')
    return await getCurrentUser(context.request)
  })
