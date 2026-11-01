import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const sessionId = 'a'.repeat(24)
const origin = `https://tengri-${sessionId}.proompteng.ai`
const desktopOrigin = 'https://proompteng.ai'
const leaseId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const expiresInMs = 60_000

async function bootstrap(name: string, url: string, payload: unknown, ok = true) {
  const navigations: string[] = []
  const messages: { data: unknown; target: string }[] = []
  const events: string[] = []
  const location = Object.assign(new URL(url), { replace: (value: string) => navigations.push(value) })
  let presented: unknown
  const script = readFileSync(
    new URL(`../../../../../services/tengri/src/${name}.js`, import.meta.url),
    'utf8',
  ).replace('__TENGRI_DESKTOP_ORIGIN_JSON__', JSON.stringify(desktopOrigin))
  runInNewContext(script, {
    URL,
    decodeURIComponent,
    window: { location, parent: { postMessage: (data: unknown, target: string) => messages.push({ data, target }) } },
    history: { replaceState: () => events.push('scrub') },
    document: { body: { textContent: '' } },
    fetch: async (_path: string, request: { body: string; credentials: string }) => {
      events.push('redeem')
      expect(request.credentials).toBe('same-origin')
      presented = JSON.parse(request.body)
      return { ok, json: async () => payload }
    },
  })
  await new Promise((resolve) => setImmediate(resolve))
  return { navigations, messages, events, presented }
}

test('normal preview bootstraps a protected cookie before navigating to the exact path and fragment', async () => {
  const result = await bootstrap('preview_bootstrap', `${origin}/_tengri/preview/open#private-token`, {
    leaseId,
    path: '/app?mode=dev',
    fragment: '#editor',
    expiresInMs,
  })
  expect(result.events).toEqual(['scrub', 'redeem'])
  expect(result.presented).toEqual({ token: 'private-token' })
  expect(result.navigations).toEqual([`${origin}/app?mode=dev#editor`])
  expect(result.messages).toEqual([
    {
      target: desktopOrigin,
      data: { channel: 'tengri-preview-lease-v1', sessionId, nonce: '', type: 'renewed', leaseId, expiresInMs },
    },
  ])
})

test('renewal acknowledges only its nonce and does not load another application document', async () => {
  const result = await bootstrap(
    'preview_bootstrap',
    `${origin}/_tengri/preview/open?__tengri_renew=own-frame#private-token`,
    {
      leaseId,
      path: '/',
      fragment: '',
      expiresInMs,
    },
  )
  expect(result.navigations).toEqual([])
  expect(result.messages).toEqual([
    {
      target: desktopOrigin,
      data: {
        channel: 'tengri-preview-lease-v1',
        sessionId,
        nonce: 'own-frame',
        type: 'renewed',
        leaseId,
        expiresInMs,
      },
    },
  ])
})

test('an authorization denial cannot acknowledge a lease or navigate into the guest', async () => {
  const result = await bootstrap(
    'preview_bootstrap',
    `${origin}/_tengri/preview/open?__tengri_renew=own-frame#private-token`,
    {},
    false,
  )
  expect(result.navigations).toEqual([])
  expect(result.messages).toEqual([
    {
      target: desktopOrigin,
      data: { channel: 'tengri-preview-lease-v1', sessionId, nonce: 'own-frame', type: 'error' },
    },
  ])
})

test('ticket redemption carries the renewal nonce without putting credentials into a query or parent message', async () => {
  const result = await bootstrap(
    'open_preview_bootstrap',
    'https://gateway.proompteng.ai/v1/preview/open?__tengri_renew=own-frame#one-use-ticket',
    {
      location: `${origin}/_tengri/preview/open#private-token`,
    },
  )
  expect(result.events).toEqual(['scrub', 'redeem'])
  expect(result.presented).toEqual({ token: 'one-use-ticket' })
  expect(result.messages).toEqual([])
  const location = new URL(result.navigations[0])
  expect(location.searchParams.toString()).toBe('__tengri_renew=own-frame')
  expect(location.hash).toBe('#private-token')
})

test('root-relative preview paths cannot turn the bootstrap into a cross-origin navigation', async () => {
  const result = await bootstrap('preview_bootstrap', `${origin}/_tengri/preview/open#private-token`, {
    leaseId,
    path: '//other.example/path',
    fragment: '#editor',
    expiresInMs,
  })
  expect(new URL(result.navigations[0]).origin).toBe(origin)
  expect(new URL(result.navigations[0]).pathname).toBe('//other.example/path')
})
