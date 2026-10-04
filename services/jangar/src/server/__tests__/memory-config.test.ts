import { describe, expect, it } from 'vitest'

import { resolveAtlasCodeSearchEmbeddingConfig, resolveEmbeddingConfig } from '~/server/memory-config'

describe('memory-config', () => {
  it('defaults self-hosted embeddings to 4096 dimensions', () => {
    const config = resolveEmbeddingConfig({
      OPENAI_EMBEDDING_API_BASE_URL: 'http://saigak.saigak.svc.cluster.local:11434/v1',
    })

    expect(config).toMatchObject({
      hosted: false,
      model: 'qwen3-embedding-saigak:8b',
      dimension: 4096,
    })
  })

  it('uses a separate 1024-dimensional Atlas code-search output from the same model', () => {
    const config = resolveAtlasCodeSearchEmbeddingConfig({
      OPENAI_EMBEDDING_API_BASE_URL: 'http://saigak.saigak.svc.cluster.local:11434/v1',
    })

    expect(config).toMatchObject({
      hosted: false,
      model: 'qwen3-embedding-saigak:8b',
      dimension: 1024,
    })
  })

  it('allows explicit Atlas model and dimension overrides without changing the shared embedding config', () => {
    const env = {
      OPENAI_EMBEDDING_API_BASE_URL: 'http://saigak.saigak.svc.cluster.local:11434/v1',
      OPENAI_EMBEDDING_DIMENSION: '4096',
      ATLAS_CODE_SEARCH_EMBEDDING_MODEL: 'atlas-model',
      ATLAS_CODE_SEARCH_EMBEDDING_DIMENSION: '768',
    }

    expect(resolveEmbeddingConfig(env)).toMatchObject({
      model: 'qwen3-embedding-saigak:8b',
      dimension: 4096,
    })
    expect(resolveAtlasCodeSearchEmbeddingConfig(env)).toMatchObject({
      model: 'atlas-model',
      dimension: 768,
    })
  })
})
