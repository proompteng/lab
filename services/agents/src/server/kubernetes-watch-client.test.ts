import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const watchMock = vi.hoisted(() => vi.fn(async () => ({ abort: vi.fn() })))
const buildBunFetchInitMock = vi.hoisted(() =>
  vi.fn<(kubeConfig: unknown, init?: unknown) => Promise<{ method: string; headers: Headers }>>(async () => ({
    method: 'GET',
    headers: new Headers(),
  })),
)
const shouldUseBunTransportMock = vi.hoisted(() => vi.fn<(env?: unknown) => boolean>(() => false))

vi.mock('@kubernetes/client-node', () => ({
  Watch: class MockWatch {
    watch = watchMock
  },
}))

vi.mock('./kubernetes-bun-transport', () => ({
  buildBunKubernetesFetchInit: (kubeConfig: unknown, init?: unknown) => buildBunFetchInitMock(kubeConfig, init),
  shouldUseBunKubernetesTransport: (env?: unknown) => shouldUseBunTransportMock(env),
}))

import { startKubernetesWatch } from './kubernetes-watch-client'

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('kubernetes-watch-client', () => {
  beforeEach(() => {
    watchMock.mockClear()
    buildBunFetchInitMock.mockClear()
    shouldUseBunTransportMock.mockReset()
    shouldUseBunTransportMock.mockReturnValue(false)
    vi.stubEnv('AGENTS_KUBE_WATCH_TIMEOUT_SECONDS', undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('delegates to the native Watch client outside Bun transport mode', async () => {
    const kubeConfig = { getCurrentCluster: () => ({ server: 'https://cluster.example' }) } as never
    const callback = vi.fn()
    const done = vi.fn()

    await startKubernetesWatch(
      kubeConfig,
      '/api/v1/namespaces/default/pods',
      { allowWatchBookmarks: true },
      callback,
      done,
    )

    expect(watchMock).toHaveBeenCalledWith(
      '/api/v1/namespaces/default/pods',
      { allowWatchBookmarks: true, timeoutSeconds: 300 },
      callback,
      done,
    )
    expect(buildBunFetchInitMock).not.toHaveBeenCalled()
  })

  it.each([
    ['120', 120],
    ['5', 300],
    ['3600', 600],
    ['invalid', 300],
  ])('uses an eligible configured watch timeout (%s -> %d seconds)', async (configured, expected) => {
    vi.stubEnv('AGENTS_KUBE_WATCH_TIMEOUT_SECONDS', configured)
    const kubeConfig = { getCurrentCluster: () => ({ server: 'https://cluster.example' }) } as never
    await startKubernetesWatch(kubeConfig, '/api/v1/pods', {}, vi.fn(), vi.fn())
    expect(watchMock).toHaveBeenCalledWith(
      '/api/v1/pods',
      { timeoutSeconds: expected },
      expect.any(Function),
      expect.any(Function),
    )
  })

  it('uses Bun fetch transport and parses newline-delimited watch events', async () => {
    shouldUseBunTransportMock.mockReturnValue(true)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const encoder = new TextEncoder()
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('{"type":"ADDED","object":{"kind":"Pod"}}\n'))
            controller.close()
          },
        }),
        { status: 200 },
      )
    })

    const callback = vi.fn()
    const done = vi.fn()
    const kubeConfig = { getCurrentCluster: () => ({ server: 'https://cluster.example' }) } as never

    await startKubernetesWatch(
      kubeConfig,
      '/api/v1/namespaces/default/pods',
      { allowWatchBookmarks: true },
      callback,
      done,
    )
    await flush()

    expect(buildBunFetchInitMock).toHaveBeenCalledWith(
      kubeConfig,
      expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) }),
    )
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ method: 'GET', headers: expect.any(Headers), timeout: 330_000 }),
    )
    const watchURL = fetchMock.mock.calls[0]?.[0] as URL
    expect(Object.fromEntries(watchURL.searchParams)).toEqual({
      watch: 'true',
      allowWatchBookmarks: 'true',
      timeoutSeconds: '300',
    })
    expect(callback).toHaveBeenCalledWith('ADDED', { kind: 'Pod' }, { type: 'ADDED', object: { kind: 'Pod' } })
    expect(done).toHaveBeenCalledWith(null)
  })

  it.each([
    { name: 'at the watch deadline', elapsedMs: 300_000, regularClose: true },
    { name: 'before the watch deadline', elapsedMs: 30_000, regularClose: false },
    { name: 'well after the watch deadline', elapsedMs: 360_000, regularClose: false },
    { name: 'with an incomplete event at the deadline', elapsedMs: 300_000, partial: true, regularClose: false },
  ])('distinguishes a Bun watch socket close $name', async ({ elapsedMs, partial, regularClose }) => {
    shouldUseBunTransportMock.mockReturnValue(true)
    const now = vi.spyOn(performance, 'now').mockReturnValue(0)
    const kubeConfig = { getCurrentCluster: () => ({ server: 'https://cluster.example' }) } as never
    const { readable, writable } = new TransformStream<Uint8Array>()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(readable))
    const callback = vi.fn()
    const { promise, resolve: done } = Promise.withResolvers<Error | null>()

    await startKubernetesWatch(kubeConfig, '/api/v1/pods', {}, callback, done)
    const writer = writable.getWriter()
    await writer.write(new TextEncoder().encode('{"type":"ADDED","object":{"kind":"Pod"}}\n'))
    if (partial) await writer.write(new TextEncoder().encode('{"type":"MOD'))
    expect(callback).toHaveBeenCalledTimes(1)

    now.mockReturnValue(elapsedMs)
    const error = Object.assign(new Error('The socket connection was closed unexpectedly.'), { code: 'ECONNRESET' })
    await writer.abort(error)

    expect(await promise).toBe(regularClose ? null : error)
  })

  it('reports a socket reset before receiving HTTP headers even at the watch deadline', async () => {
    shouldUseBunTransportMock.mockReturnValue(true)
    const now = vi.spyOn(performance, 'now').mockReturnValue(0)
    const error = Object.assign(new Error('The socket connection was closed unexpectedly.'), { code: 'ECONNRESET' })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      now.mockReturnValue(300_000)
      throw error
    })
    const kubeConfig = { getCurrentCluster: () => ({ server: 'https://cluster.example' }) } as never
    const { promise, resolve: done } = Promise.withResolvers<Error | null>()

    await startKubernetesWatch(kubeConfig, '/api/v1/pods', {}, vi.fn(), done)

    expect(await promise).toBe(error)
  })

  it('preserves HTTP failure status for watch backoff', async () => {
    shouldUseBunTransportMock.mockReturnValue(true)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 429 }))
    const kubeConfig = { getCurrentCluster: () => ({ server: 'https://cluster.example' }) } as never
    const { promise, resolve: done } = Promise.withResolvers<Error | null>()

    await startKubernetesWatch(kubeConfig, '/api/v1/pods', {}, vi.fn(), done)

    expect(await promise).toMatchObject({ message: 'Too Many Requests', statusCode: 429 })
  })
})
