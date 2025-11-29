import { describe, expect, it } from 'bun:test'

import { buildModelsResponse, supportedModels } from '../../lib/models'

describe('models route helpers', () => {
  it('buildModelsResponse returns the supported models list shape', () => {
    const { object, data } = buildModelsResponse()

    expect(object).toBe('list')
    expect(data.map((m: { id: string }) => m.id)).toEqual([...supportedModels])
    data.forEach(
      (entry: {
        object: string
        parent: string | null
        root: string
        id: string
        owned_by: string
        permission: unknown[]
      }) => {
        expect(entry.object).toBe('model')
        expect(entry.parent).toBeNull()
        expect(entry.root).toBe(entry.id)
        expect(entry.owned_by).toBe('jangar')
        expect(entry.permission).toEqual([])
      },
    )
  })
})
