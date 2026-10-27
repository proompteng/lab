import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { OrderSide } from '../execution/contracts'
import { ExecutionEvidenceKind, FillRealismSchema, measureRealism, RealismStatus } from './realism'

const id = (n: number) => n.toString(16).padStart(64, '0')
const at = (fraction: string) => `2026-10-01T14:00:00.${fraction}Z`
const sources = new Set([id(1), id(2), id(3), id(4), id(5)])
const decision = {
  decisionId: id(20),
  policyDefinitionHash: id(21),
  authorityGenerationHash: id(22),
  snapshotHash: id(1),
  decisionAt: at('100000000'),
  persistedAt: at('200000000'),
  inputs: [{ contentHash: id(2), availableAt: at('100000000') }],
}
const fill = (override: Partial<typeof FillRealismSchema.Type> = {}): typeof FillRealismSchema.Type => ({
  fillId: id(30),
  intentId: id(40),
  decisionId: decision.decisionId,
  positionOwnerGenerationHash: decision.authorityGenerationHash,
  kind: ExecutionEvidenceKind.Model,
  sourceHash: id(3),
  side: OrderSide.Buy,
  requestedQuantityAtoms: '100',
  cumulativeFilledQuantityAtoms: '40',
  fillQuantityAtoms: '40',
  quantityStepAtoms: '1',
  fillPriceAtoms: '1010000',
  priceTickAtoms: '10000',
  limitPriceAtoms: '1020000',
  bidPriceAtoms: '1000000',
  askPriceAtoms: '1010000',
  quoteHash: id(4),
  quoteAvailableAt: at('200000000'),
  quoteFreshUntil: at('900000000'),
  supportedCapacityAtoms: '50',
  capacitySourceHash: id(5),
  routingStartedAt: at('300000000'),
  requestDispatchedAt: at('300000000'),
  submissionDeadlineAt: at('900000000'),
  filledAt: at('400000000'),
  expiresAt: at('900000000'),
  ...override,
})
const evidence = (fills = [fill()]) => ({
  expectedDecisionIds: [decision.decisionId],
  expectedFillIds: fills.map((item) => item.fillId),
  decisions: [decision],
  fills,
  unsupportedAssumptions: [],
})

describe('execution realism', () => {
  test('accepts a supported partial fill without inventing the unfilled remainder', () => {
    expect(Result.getOrThrow(measureRealism(evidence(), sources)).status).toBe(RealismStatus.Supported)
  })

  test('accepts whole-second source timestamps throughout decision and fill evidence', () => {
    const start = '2026-10-01T14:00:00Z'
    const dispatched = '2026-10-01T14:00:01Z'
    const filled = '2026-10-01T14:00:02Z'
    const expires = '2026-10-01T14:00:03Z'
    const input = evidence([
      fill({
        quoteAvailableAt: start,
        quoteFreshUntil: expires,
        routingStartedAt: dispatched,
        requestDispatchedAt: dispatched,
        submissionDeadlineAt: expires,
        filledAt: filled,
        expiresAt: expires,
      }),
    ])
    input.decisions = [
      { ...decision, decisionAt: start, persistedAt: start, inputs: [{ contentHash: id(2), availableAt: start }] },
    ]
    expect(Result.getOrThrow(measureRealism(input, sources)).status).toBe(RealismStatus.Supported)
    input.decisions = [
      { ...input.decisions[0]!, inputs: [{ contentHash: id(2), availableAt: '2026-10-01T14:00:00.000000001Z' }] },
    ]
    expect(Result.getOrThrow(measureRealism(input, sources)).violations).toContain(
      `FUTURE_INPUT:${decision.decisionId}`,
    )
  })

  test('broker partial fills and price improvement need not equal an order lot or limit tick', () => {
    const actual = fill({ kind: ExecutionEvidenceKind.Broker, quantityStepAtoms: '100', fillPriceAtoms: '1009999' })
    expect(Result.getOrThrow(measureRealism(evidence([actual]), sources)).status).toBe(RealismStatus.Supported)
    expect(
      Result.getOrThrow(measureRealism(evidence([{ ...actual, limitPriceAtoms: '1020001' }]), sources)).violations,
    ).toContain(`INVALID_PRECISION:${id(30)}`)
  })

  test('time spent before dispatch cannot hide an expired quote', () => {
    const late = fill({ requestDispatchedAt: at('950000000'), filledAt: at('960000000'), expiresAt: at('990000000') })
    expect(Result.getOrThrow(measureRealism(evidence([late]), sources)).violations).toContain(
      `INVALID_EXECUTION_TIMING:${id(30)}`,
    )
  })

  test('detects future information at nanosecond precision', () => {
    const input = evidence()
    input.decisions = [{ ...decision, inputs: [{ contentHash: id(2), availableAt: at('100000001') }] }]
    const result = Result.getOrThrow(measureRealism(input, sources))
    expect(result.status).toBe(RealismStatus.Violated)
    expect(result.violations).toContain(`FUTURE_INPUT:${decision.decisionId}`)
  })

  test('unverified evidence and absent liquidity are incomplete rather than zero or full fills', () => {
    expect(Result.getOrThrow(measureRealism(evidence(), new Set())).status).toBe(RealismStatus.Incomplete)
    expect(
      Result.getOrThrow(
        measureRealism(evidence([fill({ supportedCapacityAtoms: null, capacitySourceHash: null })]), sources),
      ).status,
    ).toBe(RealismStatus.Incomplete)
  })

  test('rejects limit violations and optimistic simulated price improvement', () => {
    expect(
      Result.getOrThrow(measureRealism(evidence([fill({ fillPriceAtoms: '1030000' })]), sources)).violations,
    ).toContain(`LIMIT_VIOLATION:${id(30)}`)
    expect(
      Result.getOrThrow(measureRealism(evidence([fill({ fillPriceAtoms: '1000000' })]), sources)).violations,
    ).toContain(`UNSUPPORTED_PRICE_IMPROVEMENT:${id(30)}`)
  })

  test('cannot spend the same quoted capacity twice across fills or orders', () => {
    const second = fill({ fillId: id(31), cumulativeFilledQuantityAtoms: '80', filledAt: at('500000000') })
    expect(Result.getOrThrow(measureRealism(evidence([fill(), second]), sources)).violations).toContain(
      `UNSUPPORTED_FILL:${id(31)}`,
    )
    const anotherOrder = { ...second, intentId: id(41), cumulativeFilledQuantityAtoms: '40' }
    expect(Result.getOrThrow(measureRealism(evidence([fill(), anotherOrder]), sources)).violations).toContain(
      `UNSUPPORTED_FILL:${id(31)}`,
    )
  })

  test.each([
    [at('900'), at('900000000')],
    ['2026-10-01T14:00:01Z', '2026-10-01T14:00:01.000000000Z'],
    ['2026-10-01T14:00:01.000000000Z', '2026-10-01T14:00:01Z'],
  ])('partial fills preserve equivalent expiry instants: %s and %s', (firstExpiry, secondExpiry) => {
    const first = fill({ expiresAt: firstExpiry, supportedCapacityAtoms: '100' })
    const second = fill({
      fillId: id(31),
      expiresAt: secondExpiry,
      supportedCapacityAtoms: '100',
      cumulativeFilledQuantityAtoms: '80',
      filledAt: at('500000000'),
    })
    expect(Result.getOrThrow(measureRealism(evidence([first, second]), sources)).status).toBe(RealismStatus.Supported)
    const changedExpiry = firstExpiry.startsWith('2026-10-01T14:00:01')
      ? '2026-10-01T14:00:01.000000001Z'
      : at('900000001')
    const changed = Result.getOrThrow(
      measureRealism(evidence([first, { ...second, expiresAt: changedExpiry }]), sources),
    )
    expect(changed.status).toBe(RealismStatus.Violated)
    expect(changed.violations).toContain(`INTENT_IDENTITY_DRIFT:${id(31)}`)
  })

  test('preserves intent terms across partial fills and rejects fills after expiry', () => {
    const second = fill({
      fillId: id(31),
      requestedQuantityAtoms: '200',
      cumulativeFilledQuantityAtoms: '80',
      filledAt: at('900000001'),
    })
    const result = Result.getOrThrow(measureRealism(evidence([fill(), second]), sources))
    expect(result.violations).toContain(`INTENT_IDENTITY_DRIFT:${id(31)}`)
    expect(result.violations).toContain(`INVALID_EXECUTION_TIMING:${id(31)}`)
  })

  test('omitted decisions and fills remain missing even when supplied records are valid', () => {
    const input = evidence()
    expect(Result.getOrThrow(measureRealism({ ...input, fills: [] }, sources)).status).toBe(RealismStatus.Incomplete)
    expect(Result.getOrThrow(measureRealism({ ...input, decisions: [] }, sources)).status).toBe(
      RealismStatus.Incomplete,
    )
    expect(
      Result.getOrThrow(
        measureRealism(
          { expectedDecisionIds: [], expectedFillIds: [], decisions: [], fills: [], unsupportedAssumptions: [] },
          sources,
        ),
      ).status,
    ).toBe(RealismStatus.Incomplete)
  })
})
