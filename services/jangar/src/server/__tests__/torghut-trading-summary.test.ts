import { describe, expect, it } from 'vitest'

import { __private } from '../torghut-trading'

describe('torghut trading summary reason parsing', () => {
  it('splits semicolon-delimited risk reasons into individual tokens', () => {
    expect(__private.splitRiskReason('shorts_not_allowed;symbol_capacity_exhausted')).toEqual([
      'shorts_not_allowed',
      'symbol_capacity_exhausted',
    ])
  })

  it('keeps single reasons unchanged', () => {
    expect(__private.splitRiskReason('llm_error')).toEqual(['llm_error'])
  })
})
