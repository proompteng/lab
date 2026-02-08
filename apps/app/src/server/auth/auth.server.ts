import { betterAuth } from 'better-auth'
import { tanstackStartCookies } from 'better-auth/tanstack-start'
import { genericOAuth, keycloak } from 'better-auth/plugins'
import { Pool } from 'pg'

import type { SessionUser } from './types'

const requireEnv = (key: string): string => {
  const value = process.env[key]?.trim()
  if (!value) throw new Error(`Missing required env var ${key}`)
  return value
}

const pool = new Pool({
  connectionString: requireEnv('DATABASE_URL'),
})

export const auth = betterAuth({
  appName: 'proompteng',
  baseURL: process.env.APP_BASE_URL?.trim() || 'http://localhost:3000',
  secret: process.env.BETTER_AUTH_SECRET?.trim(),
  database: pool,
  plugins: [
    genericOAuth({
      config: [
        keycloak({
          issuer: requireEnv('APP_OIDC_ISSUER_URL'),
          clientId: requireEnv('APP_OIDC_CLIENT_ID'),
          clientSecret: requireEnv('APP_OIDC_CLIENT_SECRET'),
        }),
      ],
    }),
    tanstackStartCookies(),
  ],
})

let migrationsPromise: Promise<void> | null = null
export const ensureAuthMigrations = async () => {
  if (!migrationsPromise) {
    migrationsPromise = (async () => {
      const ctx = await auth.$context
      await ctx.runMigrations()
    })()
  }
  await migrationsPromise
}

export const getCurrentUser = async (request: Request): Promise<SessionUser | null> => {
  await ensureAuthMigrations()

  // NOTE: better-auth's getSession returns null when no session exists.
  const session = await auth.api.getSession({
    headers: request.headers,
  })

  if (!session) return null

  return {
    sub: session.user.id,
    email: session.user.email,
    name: session.user.name,
    image: session.user.image ?? null,
  }
}

export const startLoginResponse = async (request: Request): Promise<Response> => {
  await ensureAuthMigrations()

  const url = new URL(request.url)
  const next = url.searchParams.get('next')?.trim()
  const callbackURL = next && next.startsWith('/') && !next.startsWith('//') ? next : '/'

  const result = await auth.api.signInSocial({
    body: {
      provider: 'keycloak',
      callbackURL,
    },
    returnHeaders: true,
    returnStatus: true,
  })

  const nextUrl = result.response?.url
  if (!nextUrl) {
    // This should be rare; fall back to the json response.
    return new Response(JSON.stringify(result.response), {
      status: result.status ?? 500,
      headers: result.headers ?? undefined,
    })
  }

  const headers = new Headers(result.headers ?? undefined)
  headers.set('Location', nextUrl)

  return new Response(null, {
    status: 302,
    headers,
  })
}

export const logoutResponse = async (request: Request): Promise<Response> => {
  await ensureAuthMigrations()

  const result = await auth.api.signOut({
    headers: request.headers,
    body: {},
    returnHeaders: true,
    returnStatus: true,
  })

  const headers = new Headers(result.headers ?? undefined)
  headers.set('Location', '/login')

  return new Response(null, {
    status: 302,
    headers,
  })
}
