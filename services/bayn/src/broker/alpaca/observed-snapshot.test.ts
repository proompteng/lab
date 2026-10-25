import { canonicalHashV1Result } from '../../hash'
import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { observedBrokerSnapshotFixture } from './observed-snapshot.fixture'
import { decodeObservedBrokerSnapshot } from './observed-snapshot'

const observedAt = '2026-09-30T20:00:00.000Z'
const fixture = (timestamp: string) => observedBrokerSnapshotFixture('test-account', observedAt, timestamp)

describe('persisted broker timestamp evidence', () => {
  test.each([
    'createdAt',
    'updatedAt',
    'submittedAt',
    'filledAt',
    'expiredAt',
    'canceledAt',
    'failedAt',
    'replacedAt',
  ] as const)('preserves source precision in order %s and rejects invalid calendar dates', (field) => {
    const source = fixture('2026-09-29T17:15:20.123Z')
    const row = source.recentOrders.value[0]
    expect(row).toBeDefined()
    const value = {
      ...source,
      recentOrders: { ...source.recentOrders, value: [{ ...row, [field]: '2026-09-29T17:15:20.123456Z' }] },
    }
    expect(Result.getOrThrow(decodeObservedBrokerSnapshot(value)).recentOrders.value[0]?.[field]).toBe(
      '2026-09-29T17:15:20.123456Z',
    )
    expect(
      Result.isFailure(
        decodeObservedBrokerSnapshot({
          ...value,
          recentOrders: { ...value.recentOrders, value: [{ ...row, [field]: '2026-02-30T17:15:20.123456Z' }] },
        }),
      ),
    ).toBe(true)
  })
  test.each(['', '.1', '.12', '.123', '.1234', '.12345', '.123456', '.1234567', '.12345678', '.123456789'])(
    'preserves the original UTC source precision %s through JSON decoding and hashing',
    (fraction) => {
      const source = fixture(`2026-09-29T17:15:20${fraction}Z`)
      const decoded = Result.getOrThrow(decodeObservedBrokerSnapshot(JSON.parse(JSON.stringify(source))))
      expect<unknown>(decoded).toEqual(source)
      expect(Result.getOrThrow(canonicalHashV1Result(decoded))).toBe(Result.getOrThrow(canonicalHashV1Result(source)))
      expect(decoded.recentOrders.value[0]?.createdAt).toBe(`2026-09-29T17:15:20${fraction}Z`)
      expect(decoded.recentFills.value.items[0]?.transactionTime).toBe(`2026-09-29T17:15:20${fraction}Z`)
    },
  )
  test.each([
    '2026-02-30T17:15:20.123456Z',
    '2026-13-29T17:15:20Z',
    '2026-09-29T24:15:20Z',
    '2026-09-29T17:60:20Z',
    '2026-09-29T17:15:60Z',
    '2026-09-29T17:15:20.Z',
    '2026-09-29T17:15:20.1234567890Z',
    '2026-09-29T17:15:20.123+00:00',
    'not-a-timestamp',
  ])('rejects malformed source timestamp %s', (timestamp) => {
    expect(Result.isFailure(decodeObservedBrokerSnapshot(fixture(timestamp)))).toBe(true)
  })
  test('keeps observation clocks canonical even when source timestamps have greater precision', () => {
    const source = fixture('2026-09-29T17:15:20.123456Z')
    expect(
      Result.isFailure(decodeObservedBrokerSnapshot({ ...source, observedAt: '2026-09-30T20:00:00.000001Z' })),
    ).toBe(true)
    expect(Result.isFailure(decodeObservedBrokerSnapshot({ ...source, startedAt: '2026-09-30T20:00:00Z' }))).toBe(true)
  })
})

test('persisted broker observations retain USD crypto fee identity without admitting a mixed-asset debit', () => {
  const source = fixture('2026-09-29T17:15:20.123Z')
  const fee = {
    accountId: 'test-account',
    activityId: 'crypto-usd-fee',
    date: '2026-09-30' as const,
    netAmountMicros: '-200000',
    cryptoCashFee: true as const,
  }
  const value = {
    ...source,
    snapshot: {
      ...source.snapshot,
      history: {
        ...source.snapshot.history,
        fees: [{ value: fee, evidence: source.snapshot.account.evidence }],
      },
    },
  }
  const decoded = Result.getOrThrow(decodeObservedBrokerSnapshot(JSON.parse(JSON.stringify(value))))
  expect(decoded.snapshot.history.fees[0]?.value).toEqual(fee)
  expect(Result.getOrThrow(canonicalHashV1Result(decoded))).toBe(Result.getOrThrow(canonicalHashV1Result(value)))
  expect(
    Result.isFailure(
      decodeObservedBrokerSnapshot({
        ...value,
        snapshot: {
          ...value.snapshot,
          history: {
            ...value.snapshot.history,
            fees: [
              {
                value: { ...fee, coinDebit: { symbol: 'ETH/USD', quantityAtoms: '1', priceAtoms: '100000000000' } },
                evidence: source.snapshot.account.evidence,
              },
            ],
          },
        },
      }),
    ),
  ).toBe(true)
})
