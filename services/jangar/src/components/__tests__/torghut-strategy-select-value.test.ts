import { describe, expect, it } from 'vitest'

import { getTorghutStrategySelectLabel } from '@/components/torghut-strategy-select-value'

describe('getTorghutStrategySelectLabel', () => {
  it('returns the strategy name for the selected strategy id', () => {
    expect(
      getTorghutStrategySelectLabel('4b0051ba-ae40-43c1-9d8b-ad5a57a2b8f6', [
        { id: '4b0051ba-ae40-43c1-9d8b-ad5a57a2b8f6', name: 'intraday-tsmom-profit-v2' },
        { id: 'a4b5ba1c-d749-4522-bdab-9b26d2fa68de', name: 'macd-rsi-default' },
      ]),
    ).toBe('intraday-tsmom-profit-v2')
  })

  it('returns undefined when the strategy id is unknown', () => {
    expect(getTorghutStrategySelectLabel('missing', [{ id: 'known', name: 'strategy' }])).toBeUndefined()
  })
})
