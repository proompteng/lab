import { beforeEach, describe, expect, mock, test } from 'bun:test'

void mock.module('server-only', () => ({}))

let identityLookups = 0
let authConfigured = true
void mock.module('@/lib/tengri/auth', () => ({
  getTengriIdentity: async () => {
    identityLookups += 1
    return null
  },
  isTengriAuthConfigured: () => authConfigured,
}))

process.env.BETTER_AUTH_URL = 'https://proompteng.ai'

const [{ GET: getSnapshot }, { GET: watchCodexEvents }, { GET: watchFileEvents }] = await Promise.all([
  import('../../app/api/tengri/route'),
  import('../../app/api/tengri/events/route'),
  import('../../app/api/tengri/files/events/route'),
])

const handlers = [
  ['desktop snapshot', getSnapshot, 'https://proompteng.ai/api/tengri'],
  ['Codex events', watchCodexEvents, 'https://proompteng.ai/api/tengri/events?agentId=agent-test'],
  ['file events', watchFileEvents, 'https://proompteng.ai/api/tengri/files/events?agentId=agent-test&path=/workspace'],
] as const

describe('Tengri BFF GET origin enforcement', () => {
  beforeEach(() => {
    identityLookups = 0
    authConfigured = true
    process.env.BETTER_AUTH_URL = 'https://proompteng.ai'
  })

  test.each(handlers)('rejects cross-origin %s before authenticating the request', async (_name, handler, url) => {
    const response = await handler(
      new Request(url, {
        headers: {
          'sec-fetch-site': 'same-site',
        },
      }),
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'Cross-origin Tengri actions are not allowed' })
    expect(identityLookups).toBe(0)
  })

  test.each(handlers)('allows same-origin %s without requiring an Origin header', async (_name, handler, url) => {
    const response = await handler(
      new Request(url, {
        headers: {
          'sec-fetch-site': 'same-origin',
        },
      }),
    )

    expect(response.status).not.toBe(403)
    expect(identityLookups).toBe(1)
  })

  test('preserves the unconfigured localhost snapshot when BETTER_AUTH_URL is unset', async () => {
    delete process.env.BETTER_AUTH_URL
    authConfigured = false

    const response = await getSnapshot(
      new Request('http://localhost:3000/api/tengri', {
        headers: { 'sec-fetch-site': 'same-origin' },
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ authConfigured: false, authenticated: false })
    expect(identityLookups).toBe(0)
  })
})
