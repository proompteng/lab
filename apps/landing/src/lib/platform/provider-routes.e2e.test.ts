import { beforeEach, expect, mock, test } from 'bun:test'
import { create } from '@bufbuild/protobuf'
import {
  SessionSchema,
  ListProviderConnectionsResponseSchema,
  BeginProviderConnectionResponseSchema,
  CompleteProviderConnectionResponseSchema,
  ProviderConnectionProblem,
} from '@/lib/tengri/generated/proompteng/authz/v1/platform_pb'

void mock.module('server-only', () => ({}))
const auth = await import('./auth')
const ofz = await import('./ofz')
const identity = {
  subject: 'fixture',
  user: { id: 'fixture', name: 'Fixture', image: null, email: null },
  session: create(SessionSchema, { id: '11111111-1111-4111-8111-111111111111', humanId: 'fixture-human' }),
}
let authenticated = true
let completed = create(CompleteProviderConnectionResponseSchema, {
  connected: true,
  connectionId: '22222222-2222-4222-8222-222222222222',
  returnPath: '/?keep=1',
})
const calls: { name: string; input: unknown }[] = []
void mock.module('./auth', () => ({ ...auth, getPlatformIdentity: async () => (authenticated ? identity : null) }))
void mock.module('./ofz', () => ({
  ...ofz,
  ofzCall: async (method: { name: string }, input: unknown) => {
    calls.push({ name: method.name, input })
    if (method.name === 'ListProviderConnections') return create(ListProviderConnectionsResponseSchema)
    if (method.name === 'BeginProviderConnection')
      return create(BeginProviderConnectionResponseSchema, {
        authorizationUrl: 'https://provider.example/authorize?state=opaque',
      })
    if (method.name === 'CompleteProviderConnection') return completed
    throw new Error('Unexpected fixture call')
  },
}))
const directory = await import('../../app/api/platform/provider-connections/route')
const callback = await import('../../app/api/platform/provider-connections/callback/[profileId]/route')
const context = { params: Promise.resolve({ profileId: 'inventory' }) }
const binding = 'b'.repeat(43)
const state = 's'.repeat(43)
const callbackRequest = (query = 'code=one-use-code', cookie = `__Host-platform-provider=${binding}`) =>
  new Request(`https://proompteng.ai/api/platform/provider-connections/callback/inventory?state=${state}&${query}`, {
    headers: { cookie, 'sec-fetch-site': 'cross-site' },
  })
beforeEach(() => {
  process.env.PLATFORM_WEB_ORIGIN = 'https://proompteng.ai'
  calls.length = 0
  authenticated = true
  completed = create(CompleteProviderConnectionResponseSchema, {
    connected: true,
    connectionId: '22222222-2222-4222-8222-222222222222',
    returnPath: '/?keep=1',
  })
})

test('directory establishes a secure host-only binding and refuses cross-origin discovery', async () => {
  const result = await directory.GET(
    new Request('https://proompteng.ai/api/platform/provider-connections', {
      headers: { 'sec-fetch-site': 'same-origin' },
    }),
  )
  expect(result.status).toBe(200)
  expect(result.headers.get('set-cookie')).toMatch(
    /^__Host-platform-provider=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800$/,
  )
  expect(result.headers.get('cache-control')).toContain('no-store')
  calls.length = 0
  const denied = await directory.GET(
    new Request('https://proompteng.ai/api/platform/provider-connections', {
      headers: { 'sec-fetch-site': 'cross-site' },
    }),
  )
  expect(denied.status).toBe(403)
  expect(calls).toHaveLength(0)
})

test('begin requires browser binding and sends only validated current owner intent', async () => {
  const body = {
    kind: 'begin',
    operationId: '33333333-3333-4333-8333-333333333333',
    profileId: 'inventory',
    returnPath: '/?keep=1',
  }
  const request = (cookie: string) =>
    new Request('https://proompteng.ai/api/platform/provider-connections', {
      method: 'POST',
      headers: { origin: 'https://proompteng.ai', 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    })
  expect((await directory.POST(request(''))).status).toBe(409)
  expect(calls).toHaveLength(0)
  expect((await directory.POST(request(`__Host-platform-provider=${binding}`))).status).toBe(200)
  expect(calls[0]).toEqual({
    name: 'BeginProviderConnection',
    input: {
      operationId: body.operationId,
      human: { humanId: 'fixture-human', sessionId: identity.session.id, origin: 'https://proompteng.ai' },
      profileId: 'inventory',
      binding,
      returnPath: body.returnPath,
    },
  })
})

test('cross-site callback uses its original browser binding and redirects without leaking provider values', async () => {
  const result = await callback.GET(callbackRequest(), context)
  expect(result.status).toBe(303)
  expect(result.headers.get('location')).toBe(
    'https://proompteng.ai/?keep=1&platform_connection=connected&provider_profile=inventory',
  )
  expect(result.headers.get('referrer-policy')).toBe('no-referrer')
  expect(result.headers.get('cache-control')).toContain('no-store')
  expect(calls[0]).toMatchObject({
    name: 'CompleteProviderConnection',
    input: { profileId: 'inventory', state, binding, code: 'one-use-code' },
  })
  expect(await result.text()).toBe('')
})

for (const [problem, outcome] of [
  [ProviderConnectionProblem.CANCELLED, 'cancelled'],
  [ProviderConnectionProblem.ACCOUNT_MISMATCH, 'account-mismatch'],
  [ProviderConnectionProblem.ACCESS_REMOVED, 'access-removed'],
  [ProviderConnectionProblem.AUTHORIZATION_FAILED, 'failed'],
] as const) {
  test(`callback preserves the verified return path for ${outcome}`, async () => {
    completed.connected = false
    completed.problem = problem
    const result = await callback.GET(callbackRequest('error=access_denied'), context)
    expect(result.status).toBe(303)
    expect(new URL(result.headers.get('location')!).searchParams.get('platform_connection')).toBe(outcome)
    expect(result.headers.get('location')).not.toContain('access_denied')
  })
}

test('missing, duplicate or expired browser identity cannot complete a provider flow', async () => {
  for (const cookie of ['', `__Host-platform-provider=${binding}; __Host-platform-provider=${'c'.repeat(43)}`]) {
    expect((await callback.GET(callbackRequest('code=secret', cookie), context)).status).toBe(403)
  }
  authenticated = false
  expect((await callback.GET(callbackRequest(), context)).status).toBe(401)
  expect(calls).toHaveLength(0)
})

for (const returnPath of ['https://evil.example/', '//evil.example/', '/\\evil.example/', '/\nnext']) {
  test(`rejects an unsafe returned path ${JSON.stringify(returnPath)}`, async () => {
    completed.returnPath = returnPath
    const result = await callback.GET(callbackRequest(), context)
    expect(result.status).toBe(400)
    expect(result.headers.get('location')).toBeNull()
  })
}
