import { beforeAll, expect, test } from 'bun:test'
import { Effect, Result } from 'effect'
import { OrderSide } from '../execution/contracts'
import type { ExecutionDecisionDocument } from '../shadow-decision-contract'
import { makePersistenceDocumentFixture } from './decision-persistence.test-support'
import { bracketEvidenceFixture } from './bracket-evidence.test-support'
import { bindExecutionEvidence } from './execution-evidence'
import { testHash } from './fixtures.test-support'
import { ExecutionEvidenceKind, measureRealism, RealismStatus } from './realism'
import { nativeOrderSafetyFixture } from './operational-safety-orders.test-support'
import { replacementProtectionFixture } from './protection-evidence.test-support'
import { executionOrderPlans } from './execution-plans'

let document: ExecutionDecisionDocument
beforeAll(async () => {
  document = await Effect.runPromise(makePersistenceDocumentFixture('jev-native-short-assessment', 1, true))
})

test('native short fills bind the owned liability and BUY protection to the actual sealed JeV decision', () => {
  const f = bracketEvidenceFixture(document)
  const bound = Result.getOrThrow(bindExecutionEvidence(f.supplied, f.cut, document.bindings.authorityGenerationHash))
  expect(document.dispatchable).toBe(true)
  expect(bound.missing).toEqual([])
  expect(bound.fills.map((fill) => fill.side)).toEqual([OrderSide.Sell, OrderSide.Sell, OrderSide.Buy, OrderSide.Buy])
  expect(bound.fills.map((fill) => fill.pricing._tag)).toEqual([
    'SpotQuote',
    'SpotQuote',
    'NativeProtection',
    'NativeProtection',
  ])
  const realism = (fills = bound.fills) =>
    Result.getOrThrow(
      measureRealism(
        {
          expectedDecisionIds: [document.contentHash],
          expectedFillIds: fills.map((fill) => fill.fillId),
          decisions: [
            {
              decisionId: document.contentHash,
              policyDefinitionHash: testHash('short policy'),
              authorityGenerationHash: document.bindings.authorityGenerationHash,
              snapshotHash: document.bindings.snapshotContentHash,
              decisionAt: document.createdAt,
              persistedAt: f.at(1),
              inputs: [
                {
                  contentHash: document.bindings.snapshotContentHash,
                  availableAt: document.bindings.snapshotFinalizedAt,
                },
              ],
            },
          ],
          fills,
          unsupportedAssumptions: bound.missing,
        },
        new Set([...bound.sources, document.bindings.snapshotContentHash]),
      ),
    )
  expect(realism()).toMatchObject({ status: RealismStatus.Supported, violations: [], missing: [] })
  // A broker cover must retain its verified short direction; a model cannot stand in for a broker protection fill.
  for (const patch of ['direction', 'model'] as const) {
    const fills = bound.fills.map((fill) =>
      fill.pricing._tag === 'NativeProtection'
        ? {
            ...fill,
            ...(patch === 'model' ? { kind: ExecutionEvidenceKind.Model } : {}),
            pricing:
              patch === 'direction'
                ? {
                    _tag: 'NativeProtection' as const,
                    sourceHash: fill.pricing.sourceHash,
                    availableAt: fill.pricing.availableAt,
                  }
                : fill.pricing,
          }
        : fill,
    )
    expect(realism(fills).status).toBe(RealismStatus.Violated)
  }
  for (const variant of ['early-cover', 'over-cover'] as const) {
    const fills = f.cut.fills.map((fill) =>
      fill.brokerOrderId === f.stop.brokerOrderId
        ? {
            ...fill,
            ...(variant === 'early-cover'
              ? { occurredAt: f.at(3) }
              : { quantityAtoms: (BigInt(fill.quantityAtoms) + 1n).toString() }),
          }
        : fill,
    )
    const supplied = f.supplied.map((fill) => {
      const actual = fills.find((row) => row.fillId === fill.fillId)!
      return { ...fill, filledAt: actual.occurredAt, fillQuantityAtoms: actual.quantityAtoms }
    })
    expect(
      Result.isFailure(bindExecutionEvidence(supplied, { ...f.cut, fills }, document.bindings.authorityGenerationHash)),
    ).toBe(true)
  }
})

test('native operational safety accepts SELL then BUY ownership and detects a cover before the short sale', async () => {
  const f = await nativeOrderSafetyFixture(true)
  const valid = f.scan(f.source)
  expect(valid.checks.filter((check) => check.status === 'VIOLATION')).toEqual([])
  expect(valid.checks.some((check) => check.code === 'CHRONOLOGICAL_OWNED_INVENTORY' && check.status === 'PASS')).toBe(
    true,
  )
  const fills = f.rawFills.map((row) =>
    row.fill.side === OrderSide.Buy
      ? {
          ...row,
          sourceTimestamp: `${f.entry.at(3).slice(0, -1)}000000Z`,
          fill: { ...row.fill, occurredAt: f.entry.at(3) },
        }
      : row,
  )
  const invalid = f.scan({ ...f.source, fills })
  expect(
    invalid.checks.some((check) => check.code === 'CHRONOLOGICAL_OWNED_INVENTORY' && check.status === 'VIOLATION'),
  ).toBe(true)
})

test.each(['Oco', 'StopLimit'] as const)(
  'independent short %s protection retains the entry owner and BUY direction',
  (kind) => {
    const f = replacementProtectionFixture(document, kind)
    const plans = Result.getOrThrow(executionOrderPlans(f.cut.decisions, f.cut.protectionIntents))
    const cover = plans.get(f.evidence.intentId)
    expect(cover?.target.side).toBe(OrderSide.Buy)
    expect(cover?.positionOwnerDecisionId).toBe(document.contentHash)
    const bound = Result.getOrThrow(bindExecutionEvidence(f.supplied, f.cut, document.bindings.authorityGenerationHash))
    expect(bound.missing).toEqual([])
    expect(
      bound.fills
        .filter((fill) => fill.intentId === f.evidence.intentId)
        .every(
          (fill) =>
            fill.side === OrderSide.Buy &&
            fill.pricing._tag === 'NativeProtection' &&
            fill.pricing.positionSide === 'SHORT',
        ),
    ).toBe(true)
  },
)
