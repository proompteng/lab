import { expect, test } from 'bun:test'
import { equityShortIsEligible } from './equity-short'
import { shortEligibilityFixture } from './equity-short.test-support'

test('short eligibility requires every current account, configuration and borrow observation', () => {
  const at = '2026-11-13T15:00:05.000Z'
  const eligible = shortEligibilityFixture('paper', 'AAPL', at)
  expect(equityShortIsEligible(eligible, 'paper', 'AAPL', at)).toBe(true)
  for (const change of [
    { accountId: 'other' },
    { symbol: 'MSFT' },
    { accountActive: false },
    { shortingEnabled: false },
    { shortingEnabled: null },
    { noShorting: true },
    { noShorting: null },
    { assetActive: false },
    { tradable: false },
    { marginable: null },
    { shortable: false },
    { easyToBorrow: false },
    { assetObservedAt: '2026-11-13T14:59:50.000Z' },
    { configurationObservedAt: '2026-11-13T15:00:05.001Z' },
    { accountObservedAt: '2026-11-13T14:59:49.999Z' },
  ])
    expect(equityShortIsEligible({ ...eligible, ...change }, 'paper', 'AAPL', at)).toBe(false)
  expect(equityShortIsEligible(undefined, 'paper', 'AAPL', at)).toBe(false)
})
