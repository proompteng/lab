import 'server-only'

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { z } from 'zod'
import type { TengriUser } from './types'
import { controlDatabase, hashOpaque } from './control-db'
import { AuthorizationService, type Session } from './generated/proompteng/authz/v1/authz_pb'
import { isOfzConfigured, OfzError, ofzCall } from './ofz'

const SESSION_COOKIE = '__Host-tengri-session'
const OAUTH_COOKIE = '__Host-tengri-oauth'
const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const attemptSchema = z.object({ verifier: opaque, nonce: opaque, operation_id: z.uuid() })
const tokensSchema = z.object({ id_token: z.string().min(1).max(16384) })
export type TengriIdentity = { subject: string; user: TengriUser; session: Session }

function environment() {
  const base = new URL(process.env.TENGRI_DESKTOP_ORIGIN?.trim() || 'https://proompteng.ai')
  const issuer = new URL(process.env.TENGRI_OIDC_ISSUER?.trim() || 'https://auth.proompteng.ai/realms/tengri')
  const secretFile = process.env.TENGRI_OIDC_CLIENT_SECRET_FILE?.trim()
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
    !isOfzConfigured()
  )
    throw new OfzError(503)
  const secret = readFileSync(secretFile, 'utf8').trimEnd()
  if (secret.length < 32) throw new OfzError(503)
  return {
    base,
    issuer: issuer.href.replace(/\/$/, ''),
    secret,
    clientId: 'tengri-bff',
    callback: `${base.origin}/api/auth/callback`,
  }
}

export function isTengriAuthConfigured() {
  try {
    environment()
    return Boolean(
      process.env.TENGRI_DATABASE_DSN &&
      process.env.TENGRI_DATABASE_PASSWORD_FILE &&
      process.env.TENGRI_DATABASE_CA_FILE,
    )
  } catch {
    return false
  }
}

export async function getTengriIdentity(headers: Headers): Promise<TengriIdentity | null> {
  const credential = cookie(headers, SESSION_COOKIE)
  if (!credential) return null
  try {
    const response = await ofzCall(AuthorizationService.method.inspectSession, { sessionId: credential })
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

export async function handleTengriAuth(request: Request) {
  const responseHeaders = headers()
  try {
    const env = environment()
    const url = new URL(request.url)
    if (url.origin !== env.base.origin) throw new OfzError(403)
    switch (`${request.method} ${url.pathname}`) {
      case 'POST /api/auth/login':
      case 'POST /api/auth/step-up': {
        sameOrigin(request, env.base.origin)
        const state = randomBytes(32).toString('base64url')
        const binding = randomBytes(32).toString('base64url')
        const verifier = randomBytes(32).toString('base64url')
        const nonce = randomBytes(32).toString('base64url')
        const database = await controlDatabase()
        // Database time and the single delete/return below work across BFF replicas.
        await database.query('SELECT tengri.begin_oauth($1,$2,$3,$4,$5)', [
          hashOpaque(state),
          hashOpaque(binding),
          verifier,
          nonce,
          randomUUID(),
        ])
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
        responseHeaders.append('Set-Cookie', setCookie(OAUTH_COOKIE, binding, 300))
        return Response.json({ url: authorize.href }, { headers: responseHeaders })
      }
      case 'GET /api/auth/callback': {
        const state = opaque.parse(url.searchParams.get('state'))
        const code = z.string().min(1).max(4096).parse(url.searchParams.get('code'))
        const binding = cookie(request.headers, OAUTH_COOKIE)
        if (!binding || url.searchParams.has('error')) throw new OfzError(401)
        const result = await (
          await controlDatabase()
        ).query<{ verifier: unknown; nonce: unknown; operation_id: unknown }>(
          'DELETE FROM tengri.oauth_attempts WHERE state_hash=$1 AND binding_hash=$2 AND expires_at_ms>tengri.now_ms() RETURNING verifier,nonce,operation_id',
          [hashOpaque(state), hashOpaque(binding)],
        )
        if (result.rowCount !== 1) throw new OfzError(401)
        const attempt = attemptSchema.parse(result.rows[0])
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
          operationId: attempt.operation_id,
          previousCredential: cookie(request.headers, SESSION_COOKIE) || '',
          credential: randomBytes(32).toString('base64url'),
        }
        const established = await ofzCall(AuthorizationService.method.establishSession, establishment).catch(
          (error) => {
            if (!(error instanceof OfzError) || error.status !== 503) throw error
            return ofzCall(AuthorizationService.method.establishSession, establishment)
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
        const operationId = z.uuid().parse(request.headers.get('x-tengri-operation-id'))
        if (credential)
          await ofzCall(AuthorizationService.method.revokeSession, { credential, operationId, origin: env.base.origin })
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
    return Response.json(
      { error: failure.message, auditReceiptId: failure.auditReceiptId },
      { status: failure.status, headers: responseHeaders },
    )
  }
}

async function exchangeCode(env: ReturnType<typeof environment>, body: URLSearchParams) {
  const endpoint = new URL(`${env.issuer}/protocol/openid-connect/token`)
  const pinned = process.env.TENGRI_OIDC_CONNECT_IP?.trim()
  if (pinned && !isIP(pinned)) throw new OfzError(503)
  const caFile = process.env.TENGRI_OIDC_CA_FILE?.trim()
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
