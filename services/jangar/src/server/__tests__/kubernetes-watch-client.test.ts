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

vi.mock('~/server/primitives-kube', () => ({
  buildBunKubernetesFetchInit: (kubeConfig: unknown, init?: unknown) => buildBunFetchInitMock(kubeConfig, init),
  shouldUseBunKubernetesTransport: (env?: unknown) => shouldUseBunTransportMock(env),
}))

import { startKubernetesWatch } from '~/server/kubernetes-watch-client'

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('kubernetes-watch-client', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    watchMock.mockClear()
    buildBunFetchInitMock.mockClear()
    shouldUseBunTransportMock.mockReset()
    shouldUseBunTransportMock.mockReturnValue(false)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = originalFetch
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
      { allowWatchBookmarks: true },
      callback,
      done,
    )
    expect(buildBunFetchInitMock).not.toHaveBeenCalled()
  })

  it('uses Bun fetch transport and parses newline-delimited watch events', async () => {
    shouldUseBunTransportMock.mockReturnValue(true)
    const fetchMock = vi.fn(async () => {
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
    globalThis.fetch = fetchMock as unknown as typeof fetch

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
      expect.objectContaining({ method: 'GET', headers: expect.any(Headers) }),
    )
    expect(callback).toHaveBeenCalledWith('ADDED', { kind: 'Pod' }, { type: 'ADDED', object: { kind: 'Pod' } })
    expect(done).toHaveBeenCalledWith(null)
  })
})
