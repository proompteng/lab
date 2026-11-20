import { expect, it, vi } from 'vitest'

import { requestEmbedding } from './embedding-client'

it('cancels a stalled embedding at the caller deadline before the configured provider timeout', async () => {
  let providerSignal: AbortSignal | undefined
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const signal = init?.signal
    if (!signal) throw new Error('Missing embedding cancellation signal')
    providerSignal = signal
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  })
  try {
    const controller = new AbortController()
    const pending = requestEmbedding(
      'query',
      {
        apiBaseUrl: 'http://embedding.example.test/v1',
        apiKey: '',
        model: 'test',
        dimension: 3,
        timeoutMs: 120_000,
        maxInputChars: 100,
      },
      controller.signal,
    )
    controller.abort(new Error('Memory source deadline'))
    await expect(pending).rejects.toThrow('Memory source deadline')
    expect(providerSignal?.aborted).toBe(true)
  } finally {
    fetcher.mockRestore()
  }
})
