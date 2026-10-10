import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'

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
  test('cross-origin login is denied before issuing OAuth state', async () => {
    const response = await handleTengriAuth(
      new Request('https://proompteng.ai/api/auth/login', {
        method: 'POST',
        headers: { origin: 'https://untrusted.invalid', 'sec-fetch-site': 'cross-site' },
      }),
    )
    expect(response.status).toBe(403)
    expect(response.headers.getSetCookie()).toEqual([])
    expect(await response.text()).not.toContain('fixture-oidc-client-secret')
  })
  test('callback requires a full random state and code', async () => {
    const response = await handleTengriAuth(
      new Request('https://proompteng.ai/api/auth/callback?state=guess&code=code'),
    )
    expect(response.status).toBe(400)
    expect(response.headers.get('cache-control')).toContain('no-store')
  })
  test('old direct-provider and stateless-session endpoints have been removed', async () => {
    const response = await handleTengriAuth(
      new Request('https://proompteng.ai/api/auth/sign-in/social', {
        method: 'POST',
        headers: { origin: 'https://proompteng.ai' },
      }),
    )
    expect(response.status).toBe(404)
  })
})
