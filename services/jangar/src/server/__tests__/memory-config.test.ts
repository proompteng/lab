import { describe, expect, it } from 'vitest'

import { resolveEmbeddingConfig } from '~/server/memory-config'

describe('memory-config', () => {
  it('defaults self-hosted embeddings to 4096 dimensions', () => {
    const config = resolveEmbeddingConfig({
      OPENAI_EMBEDDING_API_BASE_URL: 'http://saigak.saigak.svc.cluster.local:11435/api',
    })

    expect(config).toMatchObject({
      hosted: false,
      model: 'qwen3-embedding-saigak:8b',
      dimension: 4096,
    })
  })
})
