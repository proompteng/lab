import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { cryptoMarketFixture } from '../testing/crypto-market-fixture'
import { jevEntryEconomics } from './entry-economics'
import { decodeJevProtocol, defaultJevProtocolDocument } from './protocol'
import { JevFundedExitPlanSchema } from './strategy-exit-plan'
import { jevTradePlanQuestion } from './trade-plan-choices'

test.each([
  ['AAPL', 15],
  ['BTC/USD', 60],
  ['ETH/USD', 60],
  ['SOL/USD', 60],
] as const)('%s funds its own holding horizon of %s minutes', (symbol, minutes) => {
  const protocol = Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument))
  const economics = Result.getOrThrow(
    jevEntryEconomics({
      protocol,
      symbol,
      bidMicros: 100_000_000n,
      askMicros: 100_010_000n,
      capitalMicros: '100000000000',
    }),
  )
  expect(economics?.maximumHoldingMinutes).toBe(minutes)
})

test('crypto plans retain the complete observed thirty-minute source and a sixty-minute maximum hold', () => {
  const { snapshot } = cryptoMarketFixture('ETH/USD')
  const quote = snapshot.latestQuotes['ETH/USD']
  if (quote === undefined) throw new Error('Missing ETH fixture quote')
  const economics = Result.getOrThrow(
    jevEntryEconomics({
      protocol: defaultJevProtocolDocument,
      symbol: 'ETH/USD',
      bidMicros: BigInt(Math.floor(quote.bidPrice * 1_000_000)),
      askMicros: BigInt(Math.ceil(quote.askPrice * 1_000_000)),
      capitalMicros: '100000000000',
    }),
  )
  const question = Result.getOrThrow(
    jevTradePlanQuestion({ snapshot, symbol: 'ETH/USD', economics, protocol: defaultJevProtocolDocument }),
  )
  const plans = Object.values(question.criteria).flatMap((criterion) => {
    if (criterion === null || typeof criterion !== 'object' || Array.isArray(criterion) || !('plan' in criterion))
      return []
    return [Schema.decodeUnknownSync(JevFundedExitPlanSchema)(criterion['plan'])]
  })
  expect(plans.length).toBeGreaterThan(0)
  for (const plan of plans) {
    expect(plan.levels.maximumHoldingMinutes).toBe(60)
    expect(plan.levels.sourceStartAt).toBe(snapshot.manifest.rangeStartAt)
    expect(plan.levels.sourceEndAt).toBe(snapshot.manifest.rangeEndAt)
    expect(BigInt(plan.estimatedTargetNetMicros)).toBeGreaterThan(BigInt(plan.acquisitionCostMicros))
    expect(BigInt(plan.estimatedStopNetMicros)).toBeLessThan(BigInt(plan.acquisitionCostMicros))
  }
})
