import { beforeEach, expect, mock, test } from 'bun:test'
import { create } from '@bufbuild/protobuf'
import {
  SessionSchema,
  ListPlatformAccessRequestsResponseSchema,
  ReadWorkspaceActivityResponseSchema,
} from '@/lib/tengri/generated/proompteng/authz/v1/platform_pb'

void mock.module('server-only', () => ({}))
const auth = await import('./auth')
const ofz = await import('./ofz')
const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const requestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const identity = {
  subject: 'synthetic-admin',
  user: { id: 'synthetic', name: 'Synthetic', image: null, email: 'synthetic@example.invalid' },
  session: create(SessionSchema, { humanId: 'a'.repeat(64), id: '11111111-1111-4111-8111-111111111111' }),
}
let authenticated = true
let denied = false
const calls: { name: string; input: unknown }[] = []
void mock.module('./auth', () => ({ ...auth, getPlatformIdentity: async () => (authenticated ? identity : null) }))
void mock.module('./ofz', () => ({
  ...ofz,
  ofzCall: async (method: { name: string }, input: unknown) => {
    calls.push({ name: method.name, input })
    if (denied) throw new ofz.OfzError(403)
    if (method.name === 'ReadWorkspaceActivity') return create(ReadWorkspaceActivityResponseSchema, { cursor: '91' })
    if (method.name === 'ListPlatformAccessRequests')
      return create(ListPlatformAccessRequestsResponseSchema, { cursor: `1793510000000:${requestId}` })
    throw new Error('Unexpected fixture call')
  },
}))
const activity = await import('../../app/api/platform/workspaces/[workspaceId]/activity/route')
const requests = await import('../../app/api/platform/access-requests/route')
const context = { params: Promise.resolve({ workspaceId }) }
const request = (path: string, site = 'same-origin') =>
  new Request('https://admin.proompteng.ai' + path, { headers: { 'sec-fetch-site': site } })
beforeEach(() => {
  authenticated = true
  denied = false
  calls.length = 0
  process.env.PLATFORM_PORTAL = 'admin'
  process.env.PLATFORM_WEB_ORIGIN = 'https://admin.proompteng.ai'
})

test('activity forwards validated exact filters and opaque cursor with the current server identity', async () => {
  const result = await activity.GET(
    request(
      `/api/platform/workspaces/${workspaceId}/activity?action=ofz.relationships.write&outcome=denied&actorId=fixture&cursor=100`,
    ),
    context,
  )
  expect(result.status).toBe(200)
  expect(calls[0]).toEqual({
    name: 'ReadWorkspaceActivity',
    input: {
      administrator: auth.platformSession(identity),
      workspaceId,
      action: 'ofz.relationships.write',
      outcome: 'denied',
      actorId: 'fixture',
      cursor: '100',
    },
  })
  expect(await result.json()).toEqual({ cursor: '91' })
  expect(result.headers.get('cache-control')).toContain('no-store')
})
test('history and exact request details remain scoped by the Ofz workspace contract', async () => {
  const result = await requests.GET(
    request(`/api/platform/access-requests?workspaceId=${workspaceId}&history=true&requestId=${requestId}`),
  )
  expect(result.status).toBe(200)
  expect(calls[0]?.input).toEqual({
    administrator: auth.platformSession(identity),
    workspaceId,
    history: true,
    requestId,
    cursor: undefined,
  })
  denied = true
  expect((await requests.GET(request(`/api/platform/access-requests?workspaceId=${workspaceId}`))).status).toBe(403)
})
test('invalid filters and unbounded or forged query fields never reach Ofz', async () => {
  for (const query of [
    'outcome=unknown',
    'cursor=-1',
    'action=' + 'a'.repeat(129),
    'administrator=forged',
    'actorId=%00',
  ]) {
    expect(
      (await activity.GET(request(`/api/platform/workspaces/${workspaceId}/activity?${query}`), context)).status,
    ).toBe(400)
  }
  expect(
    (await requests.GET(request(`/api/platform/access-requests?workspaceId=${workspaceId}&requestId=invalid`))).status,
  ).toBe(400)
  expect(calls).toHaveLength(0)
})
test('cross-origin, missing-session and non-admin deployments cannot read either collection', async () => {
  expect(
    (await requests.GET(request(`/api/platform/access-requests?workspaceId=${workspaceId}`, 'cross-site'))).status,
  ).toBe(403)
  authenticated = false
  expect((await activity.GET(request(`/api/platform/workspaces/${workspaceId}/activity`), context)).status).toBe(401)
  process.env.PLATFORM_PORTAL = 'desktop'
  expect((await requests.GET(request(`/api/platform/access-requests?workspaceId=${workspaceId}`))).status).toBe(404)
  expect(calls).toHaveLength(0)
})
