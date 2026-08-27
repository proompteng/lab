import 'server-only'

import { createHash } from 'node:crypto'
import { betterAuth } from 'better-auth'
import type { TengriUser } from '@/lib/tengri/types'
import { githubSubjectId } from './identity'
import { readTengriBffSecret } from './runtime-secrets'

type AuthEnvironment = ReturnType<typeof requiredAuthEnvironment>
type BetterAuth = ReturnType<typeof createTengriAuth>

let authInstance: BetterAuth | null | undefined
let authConfigurationHash: string | undefined

export function isTengriAuthConfigured() {
  return requiredAuthEnvironment().configured
}

export function getTengriAuth(): BetterAuth | null {
  const environment = requiredAuthEnvironment()
  const configurationHash = hashAuthEnvironment(environment)
  if (authInstance !== undefined && configurationHash === authConfigurationHash) return authInstance

  authConfigurationHash = configurationHash
  if (!environment.configured) {
    authInstance = null
    return authInstance
  }

  const instance = createTengriAuth(environment)
  authInstance = instance
  return instance
}

function createTengriAuth(environment: AuthEnvironment) {
  return betterAuth({
    appName: 'Tengri',
    baseURL: environment.baseUrl,
    secret: environment.secret,
    socialProviders: {
      github: {
        clientId: environment.githubClientId,
        clientSecret: environment.githubClientSecret,
        mapProfileToUser: (profile) => ({ githubId: String(profile.id) }),
        scope: ['read:user', 'user:email'],
      },
    },
    user: {
      additionalFields: {
        githubId: {
          type: 'string',
          required: true,
          input: false,
          returned: true,
        },
      },
    },
    session: {
      expiresIn: 7 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
      cookieCache: {
        enabled: true,
        maxAge: 7 * 24 * 60 * 60,
        refreshCache: true,
        strategy: 'jwe',
        version: 'tengri-v1',
      },
    },
    account: {
      storeStateStrategy: 'cookie',
      storeAccountCookie: true,
    },
    advanced: {
      cookiePrefix: 'tengri',
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        secure: environment.baseUrl.startsWith('https://'),
      },
    },
  })
}

export async function getTengriIdentity(headers: Headers): Promise<{ subject: string; user: TengriUser } | null> {
  const auth = getTengriAuth()
  if (!auth) return null
  const session = await auth.api.getSession({ headers })
  if (!session) return null
  const githubId = githubSubjectId(session.user)
  if (!githubId) return null
  return {
    subject: `github:${githubId}`,
    user: {
      id: githubId,
      name: session.user.name,
      email: session.user.email,
      image: session.user.image ?? null,
    },
  }
}

function requiredAuthEnvironment() {
  const baseUrl = process.env.BETTER_AUTH_URL?.trim() || 'http://localhost:3000'
  const secret = readTengriBffSecret('BETTER_AUTH_SECRET')
  const githubClientId = readTengriBffSecret('GITHUB_CLIENT_ID')
  const githubClientSecret = readTengriBffSecret('GITHUB_CLIENT_SECRET')
  return {
    baseUrl,
    secret,
    githubClientId,
    githubClientSecret,
    configured: secret.length >= 32 && githubClientId.length > 0 && githubClientSecret.length > 0,
  }
}

function hashAuthEnvironment(environment: AuthEnvironment) {
  return createHash('sha256')
    .update(environment.baseUrl)
    .update('\0')
    .update(environment.secret)
    .update('\0')
    .update(environment.githubClientId)
    .update('\0')
    .update(environment.githubClientSecret)
    .digest('hex')
}
