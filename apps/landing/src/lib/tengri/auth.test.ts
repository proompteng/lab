import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { githubSubjectId } from './identity'

void mock.module('server-only', () => ({}))

afterEach(() => {
  delete process.env.TENGRI_BFF_SECRET_DIR
})

describe('Tengri GitHub identity', () => {
  test('uses the provider account ID rather than Better Auth internal user ID', () => {
    expect(githubSubjectId({ githubId: '12345678' })).toBe('12345678')
  })

  test('treats missing or non-numeric provider identities as unauthenticated', () => {
    expect(githubSubjectId({})).toBeNull()
    expect(githubSubjectId({ githubId: 'internal-user-id' })).toBeNull()
  })

  test('starts GitHub OAuth with encrypted, HTTP-only stateless cookies', async () => {
    process.env.BETTER_AUTH_URL = 'http://localhost:3000'
    process.env.BETTER_AUTH_SECRET = 'better-auth-test-secret-value-1234567890'
    process.env.GITHUB_CLIENT_ID = 'github-client-id'
    process.env.GITHUB_CLIENT_SECRET = 'github-client-secret'
    const { getTengriAuth } = await import('./auth')
    const auth = getTengriAuth()
    expect(auth).not.toBeNull()

    const response = await auth!.handler(
      new Request('http://localhost:3000/api/auth/sign-in/social', {
        method: 'POST',
        body: JSON.stringify({ provider: 'github', callbackURL: '/' }),
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
      }),
    )
    const payload = (await response.json()) as { redirect?: boolean; url?: string }
    const setCookies = response.headers.getSetCookie()

    expect(response.status).toBe(200)
    expect(payload.redirect).toBe(true)
    expect(payload.url).toStartWith('https://github.com/login/oauth/authorize?')
    expect(setCookies.some((cookie) => cookie.includes('tengri.oauth_state='))).toBe(true)
    expect(setCookies.every((cookie) => cookie.includes('HttpOnly'))).toBe(true)
    expect(setCookies.every((cookie) => cookie.includes('SameSite=Lax'))).toBe(true)
    expect(setCookies.join(';')).not.toContain('github-client-secret')
  })

  test('reloads Better Auth when a projected secret rotates', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'tengri-bff-auth-'))
    process.env.TENGRI_BFF_SECRET_DIR = directory
    process.env.BETTER_AUTH_URL = 'https://proompteng.ai'
    writeSecret(directory, 'BETTER_AUTH_SECRET', 'better-auth-secret-value-before-rotation')
    writeSecret(directory, 'GITHUB_CLIENT_ID', 'github-client-id')
    writeSecret(directory, 'GITHUB_CLIENT_SECRET', 'github-client-secret-before-rotation')

    try {
      const { getTengriAuth } = await import('./auth')
      const original = getTengriAuth()
      expect(original).not.toBeNull()

      writeSecret(directory, 'GITHUB_CLIENT_SECRET', 'github-client-secret-after-rotation')
      const rotated = getTengriAuth()

      expect(rotated).not.toBeNull()
      expect(rotated).not.toBe(original)
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })
})

function writeSecret(directory: string, name: string, value: string) {
  writeFileSync(path.join(directory, name), `${value}\n`, { mode: 0o600 })
}
