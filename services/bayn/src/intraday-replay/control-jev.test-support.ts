import { Result } from 'effect'
import { OrderSide } from '../execution/contracts'
import { canonicalHashV1 } from '../hash'
import { nativeJevFixture } from '../jev/native.test-support'
import { JevPurpose } from '../jev/portfolio'
import { makeControlManagementBatch } from './control-management'
import { createControlPortfolio } from './control-portfolio'

export const controlJevFixture = (observedAt?: string) => {
  const fixture = nativeJevFixture(JevPurpose.Manage, observedAt)
  const atMs = Date.parse(fixture.snapshot.manifest.observedAt)
  const quote = (time: number) => {
    const original = fixture.snapshot.latestQuotes['AAPL']
    if (original === undefined) throw new Error('Fixture has no AAPL quote')
    const value = {
      ...original,
      bidPrice: 99.99,
      askPrice: 100,
      askSize: 5,
      bidSize: 1000,
      eventAt: new Date(time).toISOString(),
      ingestedAt: new Date(time).toISOString(),
    }
    return { value, recordHash: canonicalHashV1(value), availableAtMs: time, sequence: 1 }
  }
  const input: Parameters<typeof makeControlManagementBatch>[0] = {
    runId: '3'.repeat(64),
    entryDecisionHash: '4'.repeat(64),
    beforeEntry: Result.getOrThrow(createControlPortfolio('100000000000')),
    entryOrder: {
      symbol: 'AAPL',
      side: OrderSide.Buy,
      quantityMicros: 10_000_000n,
      protocol: fixture.protocol,
      assumptions: { latencyMs: 100, slippageBps: 0, availableLiquidityPpm: 1_000_000, feeMultiplierPpm: 1_000_000 },
      decisionAtMs: atMs - 180_100,
      arrivalAtMs: atMs - 180_000,
      decisionQuote: quote(atMs - 180_100),
      arrivalQuote: quote(atMs - 180_000),
    },
    snapshot: fixture.snapshot,
  }
  return { ...fixture, input, prepared: Result.getOrThrow(makeControlManagementBatch(input)), atMs }
}
