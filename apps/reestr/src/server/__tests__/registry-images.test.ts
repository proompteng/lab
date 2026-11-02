import { describe, expect, it } from 'bun:test'

import { __private as registryImagesPrivate } from '../registry-images'

const { filterMissingManifestTagDetails } = registryImagesPrivate

describe('filterMissingManifestTagDetails', () => {
  it('removes tags with missing manifest errors', () => {
    const details = [
      { tag: 'latest', error: 'Manifest request failed (404)' },
      { tag: 'stable' },
      { tag: 'broken', error: 'Manifest request failed (404)' },
      { tag: 'other', error: 'Timeout' },
    ]

    const filtered = filterMissingManifestTagDetails(details)

    expect(filtered.map((detail) => detail.tag)).toEqual(['stable', 'other'])
  })
})
