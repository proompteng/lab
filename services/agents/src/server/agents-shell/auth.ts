import { createHash } from 'node:crypto'

import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose'

import { PROTECTED_RESOURCE_PATH } from './constants'
import type { AgentsShellConfig } from './config'

export type OAuthChallenge = {
  error: string
  description: string
}

export type AuthContext = {
  subject: string
  email: string | null
  username: string | null
  scopes: Set<string>
  payload: JWTPayload
  authError?: OAuthChallenge
}

export const oauthProtectedResourceMetadata = (config: AgentsShellConfig) => ({
  resource: config.resource,
  authorization_servers: [config.issuer],
  scopes_supported: config.supportedScopes,
  bearer_methods_supported: ['header'],
})

const quoteAuthParam = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

export const oauthIdentityAllowed = (
  config: AgentsShellConfig,
  identity: { subject: string; email: string | null; username: string | null },
) => {
  if (config.allowedSubjects.size > 0 && !config.allowedSubjects.has(identity.subject)) return false
  if (config.allowedEmails.size === 0 && config.allowedUsernames.size === 0) return true
  return (
    (identity.email ? config.allowedEmails.has(identity.email) : false) ||
    (identity.username ? config.allowedUsernames.has(identity.username) : false)
  )
}

export const buildBearerChallenge = (config: AgentsShellConfig, error?: string, errorDescription?: string) => {
  const metadataUrl = `${config.resource.replace(/\/$/, '')}${PROTECTED_RESOURCE_PATH}`
  const parts = [`resource_metadata="${quoteAuthParam(metadataUrl)}"`]
  if (error) parts.push(`error="${error}"`)
  if (errorDescription) parts.push(`error_description="${quoteAuthParam(errorDescription)}"`)
  return `Bearer ${parts.join(', ')}`
}

export const normalizeMcpAcceptHeader = (accept: string | string[] | undefined) => {
  const value = Array.isArray(accept) ? accept.join(', ') : (accept ?? '')
  const normalized = value.toLowerCase()
  if (normalized.includes('application/json') && normalized.includes('text/event-stream')) return value
  return 'application/json, text/event-stream'
}

export const withNormalizedMcpAcceptHeader = (request: Request) => {
  const headers = new Headers(request.headers)
  headers.set('accept', normalizeMcpAcceptHeader(headers.get('accept') ?? undefined))
  return new Request(request, { headers })
}

export const bearerTokenFromRequest = (request: Request) => {
  const header = request.headers.get('authorization')
  const match = header?.match(/^Bearer\s+(.+)$/i)
  return match?.[1] ?? null
}

const hashJwtSubject = (subject: unknown) =>
  typeof subject === 'string' ? createHash('sha256').update(subject).digest('hex').slice(0, 12) : null

const normalizeJwtAudience = (audience: unknown) => {
  if (Array.isArray(audience)) return audience.filter((value): value is string => typeof value === 'string')
  return typeof audience === 'string' ? audience : null
}

const decodeSafeJwtDiagnostics = (token: string) => {
  try {
    const header = decodeProtectedHeader(token)
    const payload = decodeJwt(token)
    const nowSeconds = Math.floor(Date.now() / 1000)
    return {
      header: {
        alg: header.alg,
        typ: typeof header.typ === 'string' ? header.typ : undefined,
      },
      claims: {
        iss: payload.iss,
        aud: normalizeJwtAudience(payload.aud),
        azp: typeof payload.azp === 'string' ? payload.azp : undefined,
        scope: typeof payload.scope === 'string' ? payload.scope : undefined,
        subHash: hashJwtSubject(payload.sub),
        exp: payload.exp,
        iat: payload.iat,
        nbf: payload.nbf,
        expiresInSeconds: typeof payload.exp === 'number' ? payload.exp - nowSeconds : undefined,
        tokenAgeSeconds: typeof payload.iat === 'number' ? nowSeconds - payload.iat : undefined,
      },
    }
  } catch (error) {
    return {
      decodeError: error instanceof Error ? error.message : String(error),
    }
  }
}

export const logOAuthFailure = (request: Request, requestId: string, token: string, error: unknown) => {
  const { pathname } = new URL(request.url)
  const typedError = error as { code?: unknown }
  console.warn(
    JSON.stringify({
      msg: 'agents-shell oauth token rejected',
      requestId,
      method: request.method,
      path: pathname,
      errorName: error instanceof Error ? error.name : undefined,
      errorMessage: error instanceof Error ? error.message : String(error),
      joseCode: typeof typedError.code === 'string' ? typedError.code : undefined,
      token: decodeSafeJwtDiagnostics(token),
      userAgent: request.headers.get('user-agent'),
    }),
  )
}

export class AuthChallengeError extends Error {
  readonly oauthError: string
  readonly oauthDescription: string

  constructor(challenge: OAuthChallenge) {
    super(challenge.description)
    this.name = 'AuthChallengeError'
    this.oauthError = challenge.error
    this.oauthDescription = challenge.description
  }
}

export class AuthVerifier {
  readonly config: AgentsShellConfig
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>

  constructor(config: AgentsShellConfig) {
    this.config = config
    this.jwks = createRemoteJWKSet(new URL(config.jwksUrl))
  }

  async verify(token: string): Promise<AuthContext> {
    const result = await jwtVerify(token, this.jwks, {
      issuer: this.config.issuer,
      audience: this.config.resource,
    })
    const payload = result.payload
    const subject = payload.sub
    if (!subject) throw new Error('token is missing subject')

    const email = typeof payload.email === 'string' ? payload.email : null
    const username = typeof payload.preferred_username === 'string' ? payload.preferred_username : null
    if (!oauthIdentityAllowed(this.config, { subject, email, username })) throw new Error('identity is not allowed')

    const scopes = new Set(
      String(payload.scope ?? '')
        .split(/\s+/)
        .map((scope) => scope.trim())
        .filter(Boolean),
    )
    return { subject, email, username, scopes, payload }
  }
}

const scopesSatisfied = (auth: AuthContext, acceptedScopes: string[]) =>
  acceptedScopes.some((scope) => auth.scopes.has(scope))

export const requireScopes = (auth: AuthContext, acceptedScopes: string[]) => {
  if (auth.authError) {
    throw new AuthChallengeError(auth.authError)
  }
  if (!scopesSatisfied(auth, acceptedScopes)) {
    throw new AuthChallengeError({
      error: 'insufficient_scope',
      description: 'The requested agents-shell tool requires additional OAuth scopes.',
    })
  }
}

export const anonymousAuthContext = (authError?: OAuthChallenge): AuthContext => ({
  subject: 'unauthenticated',
  email: null,
  username: null,
  scopes: new Set(),
  payload: {},
  authError,
})
