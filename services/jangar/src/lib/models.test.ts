import { describe, expect, it } from 'bun:test'

import { buildModelsResponse, defaultCodexModel, supportedModels } from './models'

describe('defaultCodexModel', () => {
  it('falls back to the first supported model when env is unset or invalid', () => {
    expect(defaultCodexModel).toBe(supportedModels[0])
  })
})

describe('buildModelsResponse', () => {
  it('returns an entry for every supported model with expected shape', () => {
    const now = Math.floor(Date.now() / 1000)
    const { data, object } = buildModelsResponse()

    expect(object).toBe('list')
    expect(data).toHaveLength(supportedModels.length)

    data.forEach((entry, i) => {
      const expected = supportedModels[i] ?? supportedModels[0]
      expect(entry.id).toBe(expected)
      expect(entry.root).toBe(expected)
      expect(entry.owned_by).toBe('jangar')
      expect(entry.object).toBe('model')
      expect(entry.parent).toBeNull()
      // created should be a recent unix timestamp (within 10 seconds of now)
      expect(entry.created).toBeGreaterThanOrEqual(now - 10)
      expect(entry.created).toBeLessThanOrEqual(now + 10)
    })
  })
})
