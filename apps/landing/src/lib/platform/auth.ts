import 'server-only'

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { z } from 'zod'
import { PlatformAuthorizationService, type Session } from '../tengri/generated/proompteng/authz/v1/platform_pb'
import { isOfzConfigured, OfzError, ofzCall } from './ofz'
import { reportServerError } from '../observability/server'

// Stable host-only names preserve active browser authority during the gateway migration.
const SESSION_COOKIE = '__Host-tengri-session'
const OAUTH_COOKIE = '__Host-tengri-oauth'
const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const tokensSchema = z.object({ id_token: z.string().min(1).max(16384) })
export type PlatformIdentity = {
  subject: string
  user: { id: string; name: string; email: string; image: string | null }
  session: Session
}

function environment() {
  const base = new URL(process.env.PLATFORM_WEB_ORIGIN?.trim() || '')
  const issuer = new URL(process.env.PLATFORM_OIDC_ISSUER?.trim() || 'https://auth.proompteng.ai/realms/tengri')
  const secretFile = process.env.PLATFORM_OIDC_CLIENT_SECRET_FILE?.trim()
  const clientId = process.env.PLATFORM_OIDC_CLIENT_ID?.trim()
  if (
    base.protocol !== 'https:' ||
    base.username ||
    base.password ||
    base.pathname !== '/' ||
    base.search ||
    base.hash ||
    issuer.protocol !== 'https:' ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash ||
    !secretFile ||
    !clientId ||
    clientId.length > 256 ||
    /\s/.test(clientId) ||
    !isOfzConfigured()
  )
    throw new OfzError(503)
  const secret = readFileSync(secretFile, 'utf8').trimEnd()
  if (secret.length < 32) throw new OfzError(503)
  return {
    base,
    issuer: issuer.href.replace(/\/$/, ''),
    secret,
    clientId,
    callback: `${base.origin}/api/auth/callback`,
  }
}

export function isPlatformAuthConfigured() {
  try {
    environment()
    return true
  } catch {
    return false
  }
}

export async function getPlatformIdentity(headers: Headers): Promise<PlatformIdentity | null> {
  const credential = cookie(headers, SESSION_COOKIE)
  if (!credential) return null
  try {
    const response = await ofzCall(PlatformAuthorizationService.method.inspectSession, { sessionId: credential })
    const session = response.session
    if (
      !session ||
      !/^[1-9][0-9]{0,19}$/.test(session.githubId) ||
      session.humanId !== createHash('sha256').update(`github:${session.githubId}`).digest('hex')
    )
      throw new OfzError(503)
    return {
      subject: `github:${session.githubId}`,
      session,
      user: { id: session.githubId, name: session.displayName, email: session.email, image: session.imageUrl || null },
    }
  } catch (error) {
    if (error instanceof OfzError && [401, 403].includes(error.status)) return null
    throw error
  }
}

function cookie(headers: Headers, name: string) {
  const values = (headers.get('cookie') || '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
  if (values.length !== 1) return null
  const parsed = opaque.safeParse(values[0]?.slice(name.length + 1))
  return parsed.success ? parsed.data : null
}

function setCookie(name: string, value: string, maxAge: number) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAge))}`
}
function headers() {
  return new Headers({
    'Cache-Control': 'no-store, max-age=0',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  })
}
function sameOrigin(request: Request, origin: string) {
  if (request.headers.get('origin') !== origin || request.headers.get('sec-fetch-site') === 'cross-site')
    throw new OfzError(403)
}

export async function handlePlatformAuth(request: Request) {
  const responseHeaders = headers()
  try {
    const env = environment()
    const url = new URL(request.url)
    if (request.headers.get('host') !== env.base.host) throw new OfzError(403)
    switch (`${request.method} ${url.pathname}`) {
      case 'POST /api/auth/login':
      case 'POST /api/auth/add-passkey':
      case 'POST /api/auth/step-up': {
        sameOrigin(request, env.base.origin)
        const state = randomBytes(32).toString('base64url')
        const binding = randomBytes(32).toString('base64url')
        const verifier = randomBytes(32).toString('base64url')
        const nonce = randomBytes(32).toString('base64url')
        await ofzCall(PlatformAuthorizationService.method.beginSignIn, {
          state,
          binding,
          verifier,
          nonce,
          operationId: randomUUID(),
        })
        const authorize = new URL(`${env.issuer}/protocol/openid-connect/auth`)
        authorize.search = new URLSearchParams({
          client_id: env.clientId,
          redirect_uri: env.callback,
          response_type: 'code',
          scope: 'openid profile email',
          state,
          nonce,
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          code_challenge_method: 'S256',
          kc_idp_hint: 'github',
          acr_values: '2',
          prompt: 'login',
          max_age: '0',
        }).toString()
        if (url.pathname === '/api/auth/add-passkey') authorize.searchParams.set('kc_action', 'webauthn-register')
        responseHeaders.append('Set-Cookie', setCookie(OAUTH_COOKIE, binding, 300))
        return Response.json({ url: authorize.href }, { headers: responseHeaders })
      }
      case 'GET /api/auth/callback': {
        if (url.searchParams.has('error')) {
          responseHeaders.append('Set-Cookie', setCookie(OAUTH_COOKIE, '', 0))
          throw new OfzError(401)
        }
        const state = opaque.parse(url.searchParams.get('state'))
        const code = z.string().min(1).max(4096).parse(url.searchParams.get('code'))
        const binding = cookie(request.headers, OAUTH_COOKIE)
        if (!binding) throw new OfzError(401)
        const attempt = await ofzCall(PlatformAuthorizationService.method.consumeSignIn, { state, binding })
        const tokens = await exchangeCode(
          env,
          new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: env.callback,
            client_id: env.clientId,
            client_secret: env.secret,
            code_verifier: attempt.verifier,
          }),
        )
        const establishment = {
          identityToken: tokens.id_token,
          nonce: attempt.nonce,
          operationId: attempt.operationId,
          previousCredential: cookie(request.headers, SESSION_COOKIE) || '',
          credential: randomBytes(32).toString('base64url'),
        }
        const established = await ofzCall(PlatformAuthorizationService.method.establishSession, establishment).catch(
          (error) => {
            if (!(error instanceof OfzError) || error.status !== 503) throw error
            return ofzCall(PlatformAuthorizationService.method.establishSession, establishment)
          },
        )
        const session = established.session
        if (!session || !opaque.safeParse(session.credential).success) throw new OfzError(503)
        responseHeaders.append(
          'Set-Cookie',
          setCookie(SESSION_COOKIE, session.credential, Number(session.expiresAtUnixMs - BigInt(Date.now())) / 1000),
        )
        responseHeaders.append('Set-Cookie', setCookie(OAUTH_COOKIE, '', 0))
        responseHeaders.set('Location', env.base.origin + '/')
        return new Response(null, { status: 303, headers: responseHeaders })
      }
      case 'POST /api/auth/logout': {
        sameOrigin(request, env.base.origin)
        const credential = cookie(request.headers, SESSION_COOKIE)
        const operationId = z.uuid().parse(request.headers.get('x-platform-operation-id'))
        if (credential)
          await ofzCall(PlatformAuthorizationService.method.revokeSession, {
            credential,
            operationId,
            origin: env.base.origin,
          })
        responseHeaders.append('Set-Cookie', setCookie(SESSION_COOKIE, '', 0))
        responseHeaders.append('Set-Cookie', setCookie(OAUTH_COOKIE, '', 0))
        return new Response(null, { status: 204, headers: responseHeaders })
      }
    }
    return Response.json({ error: 'Authentication endpoint not found' }, { status: 404, headers: responseHeaders })
  } catch (error) {
    const exhausted = z.object({ code: z.literal('53300') }).safeParse(error)
    const failure =
      error instanceof OfzError
        ? error
        : error instanceof z.ZodError
          ? new OfzError(400)
          : new OfzError(exhausted.success ? 429 : 503)
    if (failure.status >= 500) reportServerError(error, 'platform.auth', failure.status)
    return Response.json(
      {
        error:
          failure.status === 503 && !(error instanceof OfzError)
            ? 'Sign-in is unavailable. Try again shortly.'
            : failure.message,
        auditReceiptId: failure.auditReceiptId,
      },
      { status: failure.status, headers: responseHeaders },
    )
  }
}

async function exchangeCode(env: ReturnType<typeof environment>, body: URLSearchParams) {
  const endpoint = new URL(`${env.issuer}/protocol/openid-connect/token`)
  const pinned = process.env.PLATFORM_OIDC_CONNECT_IP?.trim()
  if (pinned && !isIP(pinned)) throw new OfzError(503)
  const caFile = process.env.PLATFORM_OIDC_CA_FILE?.trim()
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const encoded = body.toString()
    const call = httpsRequest(
      {
        protocol: 'https:',
        hostname: pinned || endpoint.hostname,
        port: endpoint.port || 443,
        path: endpoint.pathname,
        servername: endpoint.hostname,
        method: 'POST',
        headers: {
          Host: endpoint.host,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(encoded),
        },
        ...(caFile ? { ca: readFileSync(caFile) } : {}),
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          reject(new OfzError(response.statusCode === 400 || response.statusCode === 401 ? 401 : 503))
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 65536) call.destroy(new OfzError(503))
          else chunks.push(chunk)
        })
        response.on('end', () => resolve(Buffer.concat(chunks)))
        response.on('error', () => reject(new OfzError(503)))
        response.on('aborted', () => reject(new OfzError(503)))
      },
    )
    const timeout = setTimeout(() => call.destroy(new OfzError(503)), 2000)
    call.on('close', () => clearTimeout(timeout))
    call.on('error', () => reject(new OfzError(503)))
    call.end(encoded)
  })
  return tokensSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
}
