import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'

void mock.module('server-only', () => ({}))

let identityLookups = 0
let authConfigured = true
const auth = await import('../platform/auth')
let restoreAuth = () => {}

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
    const priorOrigin = process.env.PLATFORM_WEB_ORIGIN
    process.env.PLATFORM_WEB_ORIGIN = 'https://proompteng.ai'
    // Replacing the module drops unrelated exports for later auth tests. Scoped
    // spies keep the real module intact regardless of test discovery order.
    const identity = spyOn(auth, 'getPlatformIdentity').mockImplementation(async () => {
      identityLookups += 1
      return null
    })
    const configured = spyOn(auth, 'isPlatformAuthConfigured').mockImplementation(() => authConfigured)
    restoreAuth = () => {
      identity.mockRestore()
      configured.mockRestore()
      if (priorOrigin === undefined) delete process.env.PLATFORM_WEB_ORIGIN
      else process.env.PLATFORM_WEB_ORIGIN = priorOrigin
    }
  })

  afterEach(() => restoreAuth())

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

  test('uses the fixed public origin for an unconfigured snapshot', async () => {
    delete process.env.PLATFORM_WEB_ORIGIN
    authConfigured = false

    const response = await getSnapshot(
      new Request('https://proompteng.ai/api/tengri', {
        headers: { 'sec-fetch-site': 'same-origin' },
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ authConfigured: false, authenticated: false })
    expect(identityLookups).toBe(0)
  })
})
