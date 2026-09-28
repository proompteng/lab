import { describe, expect, it } from 'vitest'

import { MAX_PGVECTOR_ANN_DIMENSION, supportsPgvectorAnnIndex } from '~/server/pgvector-indexing'

describe('pgvector indexing', () => {
  it('allows ANN indexes at or below the pgvector limit', () => {
    expect(supportsPgvectorAnnIndex(MAX_PGVECTOR_ANN_DIMENSION)).toBe(true)
    expect(supportsPgvectorAnnIndex(1536)).toBe(true)
  })

  it('disables ANN indexes above the pgvector limit', () => {
    expect(supportsPgvectorAnnIndex(4096)).toBe(false)
  })
})
