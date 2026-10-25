import { afterEach, describe, expect, it, vi } from 'vitest'

import { requestEmbeddings } from '../embedding-client'

const baseConfig = {
  apiBaseUrl: 'http://saigak.saigak.svc.cluster.local:11434/v1',
  apiKey: null,
  model: 'qwen3-embedding-saigak:8b',
  dimension: 3,
  timeoutMs: 5_000,
  maxInputChars: 10_000,
} as const

afterEach(() => {
  vi.restoreAllMocks()
})

describe('embedding-client', () => {
  it('sends dimensions to the OpenAI-compatible embeddings endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ embedding: [0.1, 0.2, 0.3] }],
      }),
    } as Response)

    await expect(requestEmbeddings(['hello world'], baseConfig)).resolves.toEqual([[0.1, 0.2, 0.3]])

    expect(fetchMock).toHaveBeenCalledWith(
      'http://saigak.saigak.svc.cluster.local:11434/v1/embeddings',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          model: 'qwen3-embedding-saigak:8b',
          input: 'hello world',
          dimensions: 3,
        }),
      }),
    )
  })

  it('uses the Ollama embed endpoint when the embedding base URL ends with /api', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        embeddings: [
          [0.1, 0.2, 0.3],
          [0.4, 0.5, 0.6],
        ],
      }),
    } as Response)

    await expect(
      requestEmbeddings(['first', 'second'], {
        ...baseConfig,
        apiBaseUrl: 'http://saigak.saigak.svc.cluster.local:11434/api',
      }),
    ).resolves.toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ])

    expect(fetchMock).toHaveBeenCalledWith(
      'http://saigak.saigak.svc.cluster.local:11434/api/embed',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          model: 'qwen3-embedding-saigak:8b',
          input: ['first', 'second'],
          dimensions: 3,
        }),
      }),
    )
  })
})
