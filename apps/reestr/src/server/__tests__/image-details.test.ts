import { describe, expect, it } from 'bun:test'

import type { TagManifestBreakdown } from '~/lib/registry'
import { __private as imageDetailsPrivate } from '../image-details'

const { filterMissingManifestBreakdowns } = imageDetailsPrivate

describe('filterMissingManifestBreakdowns', () => {
  it('removes tag breakdowns with missing manifest errors', () => {
    const breakdowns = [
      { tag: 'latest', manifestType: 'single', error: 'Manifest request failed (404)' },
      { tag: 'stable', manifestType: 'single' },
      { tag: 'oops', manifestType: 'single', error: 'Manifest request failed (404)' },
      { tag: 'other', manifestType: 'single', error: 'Timeout' },
    ] satisfies TagManifestBreakdown[]

    const filtered = filterMissingManifestBreakdowns(breakdowns)

    expect(filtered.map((detail) => detail.tag)).toEqual(['stable', 'other'])
  })
})
