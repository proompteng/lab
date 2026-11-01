import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test'
import * as Sentry from '@sentry/node'

void mock.module('server-only', () => ({}))
const { getTengriIdentity, handleTengriAuth } = await import('./auth')
const directory = mkdtempSync(path.join(tmpdir(), 'tengri-auth-'))
const settings = {
  TENGRI_DESKTOP_ORIGIN: 'https://proompteng.ai',
  TENGRI_OIDC_ISSUER: 'https://auth.proompteng.ai/realms/tengri',
  TENGRI_OIDC_CLIENT_SECRET_FILE: path.join(directory, 'oidc-secret'),
  OFZ_GRPC_ENDPOINT: 'ofz-api.ofz.svc.cluster.local:9443',
  SPIFFE_ENDPOINT_SOCKET: 'unix:///unavailable-fixture.sock',
  SPIFFE_ID: 'spiffe://proompteng.ai/ns/proompteng/sa/proompteng',
}
const prior = new Map(Object.keys(settings).map((name) => [name, process.env[name]]))
beforeAll(() => {
  writeFileSync(settings.TENGRI_OIDC_CLIENT_SECRET_FILE, 'fixture-oidc-client-secret-with-over-32-bytes', {
    mode: 0o600,
  })
  Object.assign(process.env, settings)
})
afterAll(() => {
  for (const [name, value] of prior) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(directory, { recursive: true, force: true })
})

describe('Ofz-backed browser authentication boundary', () => {
  test('reports a caught authentication outage while preserving its 503 response', async () => {
    const capture = spyOn(Sentry, 'captureException').mockReturnValue('fixture-event')
    process.env.TENGRI_OIDC_CLIENT_SECRET_FILE = path.join(directory, 'missing-secret')
    try {
      const response = await handleTengriAuth(
        new Request('https://proompteng.ai/api/auth/login', {
          method: 'POST',
          headers: { host: 'proompteng.ai', origin: 'https://proompteng.ai', 'sec-fetch-site': 'same-origin' },
        }),
      )
      expect(response.status).toBe(503)
      expect(capture).toHaveBeenCalledTimes(1)
      expect(capture.mock.calls[0]?.[0]).toMatchObject({ code: 'ENOENT' })
      const body = await response.text()
      expect(JSON.parse(body)).toEqual({
        error: 'Sign-in is unavailable. Try again shortly.',
        auditReceiptId: '',
      })
      expect(body).not.toContain('missing-secret')
    } finally {
      process.env.TENGRI_OIDC_CLIENT_SECRET_FILE = settings.TENGRI_OIDC_CLIENT_SECRET_FILE
      capture.mockRestore()
    }
  })
  test('absent, malformed, duplicate and legacy cookies never authenticate', async () => {
    for (const value of [
      '',
      '__Host-tengri-session=public-session-uuid',
      `__Host-tengri-session=${'a'.repeat(43)}; __Host-tengri-session=${'b'.repeat(43)}`,
      'tengri.session_token=old-better-auth-credential',
    ]) {
      expect(await getTengriIdentity(new Headers({ cookie: value }))).toBeNull()
    }
  })
  test.each(['login', 'step-up', 'add-passkey'])(
    'cross-origin %s is denied before issuing OAuth state',
    async (action) => {
      const response = await handleTengriAuth(
        new Request(`https://proompteng.ai/api/auth/${action}`, {
          method: 'POST',
          headers: { host: 'proompteng.ai', origin: 'https://untrusted.invalid', 'sec-fetch-site': 'cross-site' },
        }),
      )
      expect(response.status).toBe(403)
      expect(response.headers.getSetCookie()).toEqual([])
      expect(await response.text()).not.toContain('fixture-oidc-client-secret')
    },
  )
  test('callback requires a full random state and code', async () => {
    const response = await handleTengriAuth(
      new Request('https://proompteng.ai/api/auth/callback?state=guess&code=code', {
        headers: { host: 'proompteng.ai' },
      }),
    )
    expect(response.status).toBe(400)
    expect(response.headers.get('cache-control')).toContain('no-store')
  })
  test('cancelled OIDC callbacks clear the attempt cookie without requiring an authorization code', async () => {
    const response = await handleTengriAuth(
      new Request(`https://proompteng.ai/api/auth/callback?error=access_denied&state=${'a'.repeat(43)}`, {
        headers: { host: 'proompteng.ai', cookie: `__Host-tengri-oauth=${'b'.repeat(43)}` },
      }),
    )
    expect(response.status).toBe(401)
    expect(response.headers.getSetCookie()).toContain(
      '__Host-tengri-oauth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    )
    expect(response.headers.get('cache-control')).toContain('no-store')
  })
  test.each(['http://0.0.0.0:3000', 'https://0.0.0.0:3000'])(
    'accepts the public Host behind Next internal URL %s',
    async (internalOrigin) => {
      const response = await handleTengriAuth(
        new Request(`${internalOrigin}/api/auth/callback?error=access_denied`, {
          headers: { host: 'proompteng.ai' },
        }),
      )
      expect(response.status).toBe(401)
      expect(response.headers.getSetCookie()).toContain(
        '__Host-tengri-oauth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
      )
    },
  )
  test.each(['untrusted.invalid', 'proompteng.ai.evil.invalid', 'proompteng.ai:3000', ''])(
    'rejects the wrong public Host %s even with a forged forwarded host',
    async (host) => {
      const response = await handleTengriAuth(
        new Request('http://0.0.0.0:3000/api/auth/login', {
          method: 'POST',
          headers: {
            host,
            origin: 'https://proompteng.ai',
            'x-forwarded-host': 'proompteng.ai',
            'sec-fetch-site': 'same-origin',
          },
        }),
      )
      expect(response.status).toBe(403)
      expect(response.headers.getSetCookie()).toEqual([])
    },
  )
  test('old direct-provider and stateless-session endpoints have been removed', async () => {
    const response = await handleTengriAuth(
      new Request('https://proompteng.ai/api/auth/sign-in/social', {
        method: 'POST',
        headers: { host: 'proompteng.ai', origin: 'https://proompteng.ai' },
      }),
    )
    expect(response.status).toBe(404)
  })
})
