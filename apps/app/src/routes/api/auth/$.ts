import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const { auth, ensureAuthMigrations } = await import('../../../server/auth/auth.server')
        await ensureAuthMigrations()
        return await auth.handler(request)
      },
      POST: async ({ request }: { request: Request }) => {
        const { auth, ensureAuthMigrations } = await import('../../../server/auth/auth.server')
        await ensureAuthMigrations()
        return await auth.handler(request)
      },
      OPTIONS: async ({ request }: { request: Request }) => {
        const { auth, ensureAuthMigrations } = await import('../../../server/auth/auth.server')
        await ensureAuthMigrations()
        return await auth.handler(request)
      },
    },
  },
})
