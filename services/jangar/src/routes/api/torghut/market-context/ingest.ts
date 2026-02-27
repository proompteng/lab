import { timingSafeEqual } from 'node:crypto'

import { AuthenticationV1Api, KubeConfig } from '@kubernetes/client-node'
import { createFileRoute } from '@tanstack/react-router'
import { ingestMarketContextProviderResult } from '~/server/torghut-market-context-agents'

export const Route = createFileRoute('/api/torghut/market-context/ingest')({
  server: {
    handlers: {
      POST: async ({ request }) => postMarketContextIngestHandler(request),
    },
  },
})

const jsonResponse = (payload: unknown, status = 200) => {
  const body = JSON.stringify(payload)
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body).toString(),
    },
  })
}

const DEFAULT_ALLOWED_SERVICE_ACCOUNT_PREFIX = 'system:serviceaccount:agents:'

type ServiceAccountTokenVerifier = (token: string) => Promise<boolean>

let authApi: AuthenticationV1Api | null | undefined
let serviceAccountTokenVerifierOverride: ServiceAccountTokenVerifier | null = null

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  if (!value) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false
  return fallback
}

const resolveAllowedServiceAccountPrefixes = () => {
  const raw = process.env.JANGAR_MARKET_CONTEXT_INGEST_ALLOWED_SERVICE_ACCOUNT_PREFIXES?.trim()
  if (!raw) return [DEFAULT_ALLOWED_SERVICE_ACCOUNT_PREFIX]
  const prefixes = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  return prefixes.length > 0 ? prefixes : [DEFAULT_ALLOWED_SERVICE_ACCOUNT_PREFIX]
}

const resolveAuthApi = () => {
  if (authApi !== undefined) return authApi
  try {
    const kubeConfig = new KubeConfig()
    kubeConfig.loadFromCluster()
    authApi = kubeConfig.makeApiClient(AuthenticationV1Api)
  } catch {
    authApi = null
  }
  return authApi
}

const verifyServiceAccountTokenWithTokenReview = async (token: string) => {
  const api = resolveAuthApi()
  if (!api) return false

  try {
    const response = (await (
      api as unknown as { createTokenReview: (body: unknown) => Promise<unknown> }
    ).createTokenReview({
      apiVersion: 'authentication.k8s.io/v1',
      kind: 'TokenReview',
      spec: { token },
    })) as { body?: Record<string, unknown> } | Record<string, unknown>
    const body =
      response &&
      typeof response === 'object' &&
      'body' in response &&
      response.body &&
      typeof response.body === 'object'
        ? response.body
        : response
    const bodyRecord = body && typeof body === 'object' ? (body as Record<string, unknown>) : null
    const status =
      bodyRecord && bodyRecord.status && typeof bodyRecord.status === 'object'
        ? (bodyRecord.status as Record<string, unknown>)
        : null
    if (!status || status.authenticated !== true) return false

    const user = status.user
    if (!user || typeof user !== 'object') return false
    const username =
      typeof (user as Record<string, unknown>).username === 'string'
        ? ((user as Record<string, unknown>).username as string)
        : ''
    if (!username) return false

    const allowedPrefixes = resolveAllowedServiceAccountPrefixes()
    return allowedPrefixes.some((prefix) => username.startsWith(prefix))
  } catch {
    return false
  }
}

const verifyServiceAccountToken = async (token: string) => {
  const override = serviceAccountTokenVerifierOverride
  if (override) return override(token)
  return verifyServiceAccountTokenWithTokenReview(token)
}

const resolveSharedIngestToken = () => {
  const token = process.env.JANGAR_MARKET_CONTEXT_INGEST_TOKEN?.trim()
  return token && token.length > 0 ? token : null
}

const resolveServiceAccountTokenAuthEnabled = () =>
  parseBoolean(process.env.JANGAR_MARKET_CONTEXT_INGEST_ALLOW_SERVICE_ACCOUNT_TOKEN, true)

const safeEquals = (left: string, right: string) => {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  if (leftBuffer.length !== rightBuffer.length) return false
  return timingSafeEqual(leftBuffer, rightBuffer)
}

const resolveBearerToken = (request: Request) => {
  const raw = request.headers.get('authorization')?.trim()
  if (!raw) return null
  const [scheme, ...rest] = raw.split(/\s+/g)
  if (scheme.toLowerCase() !== 'bearer') return null
  const token = rest.join(' ').trim()
  return token.length > 0 ? token : null
}

const isIngestAuthorized = async (request: Request) => {
  const actual = resolveBearerToken(request)
  if (!actual) return false

  const expected = resolveSharedIngestToken()
  if (expected && safeEquals(actual, expected)) return true
  if (!resolveServiceAccountTokenAuthEnabled()) return false
  return verifyServiceAccountToken(actual)
}

export const __setIngestServiceAccountTokenVerifierForTests = (verifier: ServiceAccountTokenVerifier | null) => {
  serviceAccountTokenVerifierOverride = verifier
  authApi = undefined
}

export const postMarketContextIngestHandler = async (request: Request) => {
  if (!(await isIngestAuthorized(request))) {
    return jsonResponse({ ok: false, message: 'unauthorized' }, 401)
  }

  const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return jsonResponse({ ok: false, message: 'invalid JSON payload' }, 400)
  }

  try {
    const result = await ingestMarketContextProviderResult(payload)
    return jsonResponse(result, 202)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'market context ingest failed'
    return jsonResponse({ ok: false, message }, 400)
  }
}
