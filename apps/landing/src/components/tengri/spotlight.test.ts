import { describe, expect, test } from 'bun:test'
import { fuzzy, spotlightResultOptionId } from './spotlight'

describe('Tengri Spotlight matching', () => {
  test('matches ordered characters without requiring a contiguous substring', () => {
    expect(fuzzy('terminal', 'tml')).toBe(true)
    expect(fuzzy('open agent settings', 'oast')).toBe(true)
  })

  test('rejects out-of-order characters and accepts an empty query', () => {
    expect(fuzzy('terminal', 'tam')).toBe(false)
    expect(fuzzy('finder', '')).toBe(true)
  })

  test('creates a whitespace-safe option ID for file results', () => {
    expect(spotlightResultOptionId('file:/workspace/My File.ts')).toBe(
      'spotlight-result-file%3A%2Fworkspace%2FMy%20File.ts',
    )
  })
})
