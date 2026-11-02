import { expect, test } from 'bun:test'
import { Result } from 'effect'
import { decodeJevPortfolio, JevPurpose } from './portfolio'
import { nativeJevFixture } from './native.test-support'
import { reconciledStateHash } from '../simulation-reconciliation/broker-model'
import { jevProfitTargetBid } from './profit-target'

test('accounted protective disposals explain a remaining position without changing its strategy prices', () => {
  const original = nativeJevFixture(JevPurpose.Manage).portfolio
  if (original.purpose !== JevPurpose.Manage) throw new Error('Held fixture required')
  const material = {
    ...original.brokerState,
    positions: original.brokerState.positions.map((position) => ({
      ...position,
      quantityAtoms: '3000000000',
      costBasisMicros: '300000000',
    })),
  }
  const hash = Result.getOrThrow(reconciledStateHash(material))
  const partial = {
    ...original,
    protectionDisposals: { quantityAtoms: '2000000000', costBasisMicros: '200000000' },
    exitRequestedAt: original.entryFills[0]?.occurredAt ?? null,
    brokerState: {
      ...material,
      reconciliation: { ...material.reconciliation, expectedHash: hash, observedHash: hash },
    },
  }
  expect(Result.isSuccess(decodeJevPortfolio(partial))).toBe(true)
  expect(Result.getOrThrow(jevProfitTargetBid(partial))).toBe(Result.getOrThrow(jevProfitTargetBid(original)))
  expect(
    Result.isFailure(
      decodeJevPortfolio({ ...partial, protectionDisposals: { quantityAtoms: '0', costBasisMicros: '0' } }),
    ),
  ).toBe(true)
})
