import { describe, expect, it } from 'vitest'

import { __private } from '../torghut-quant-runtime'

describe('torghut quant runtime account selection', () => {
  it('always includes aggregate account frame when no accounts are present', () => {
    expect(__private.resolveStrategyAccountsForCompute([])).toEqual([''])
  })

  it('includes aggregate frame plus all non-empty account labels', () => {
    expect(__private.resolveStrategyAccountsForCompute(['paper-a', ' paper-b ', ''])).toEqual([
      '',
      'paper-a',
      'paper-b',
    ])
  })
})
