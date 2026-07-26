import assert from 'node:assert/strict'

import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1 } from './hash'
import { evaluateReference, measureReferenceEvaluationWork, restrictReferenceBuyFill } from './audit/reference'
import { evaluateRiskBalancedTrend } from './risk-balanced-trend'
import { fixtureProtocol, makeSnapshot, makeTestProvenance } from './test-fixtures'

const assertSuccess = <A, E>(result: Result.Result<A, E>): A => {
  assert(Result.isSuccess(result), 'strategy evaluation fixture must succeed')
  return result.success
}

const assertFailure = <A, E>(result: Result.Result<A, E>): E => {
  assert(Result.isFailure(result), 'reference evaluation fixture must fail')
  return result.failure
}

describe('independent qualification reference', () => {
  test('reproduces every persisted strategy and benchmark artifact', () => {
    const snapshot = makeSnapshot(900)
    const provenance = makeTestProvenance()
    const actual = assertSuccess(
      evaluateRiskBalancedTrend(snapshot.bars, snapshot.manifest, fixtureProtocol, provenance),
    )
    const reference = assertSuccess(evaluateReference(snapshot.bars, snapshot.manifest, fixtureProtocol, provenance))

    expect(reference.runId).toBe(actual.runId)
    expect(reference.protocolHash).toBe(actual.protocolHash)
    expect(reference.strategy.metrics).toEqual(actual.strategy)
    expect(reference.buyAndHold.metrics).toEqual(actual.buyAndHold)
    expect(reference.directVolTiming.metrics).toEqual(actual.directVolTiming)
    expect(reference.doubleCostStrategy.metrics).toEqual(actual.doubleCostStrategy)
    expect(reference.verdict).toEqual(actual.verdict)
    expect(reference.strategy.events).toEqual(actual.events)
    expect(reference.strategy.decisions).toEqual(actual.signalDecisions)
    expect(reference.strategy.trace).toEqual(actual.simulation)
    expect('work' in reference.strategy).toBe(false)
    expect(reference.buyAndHold.daily).toEqual(actual.benchmarkSeries.buyAndHold)
    expect(reference.directVolTiming.daily).toEqual(actual.benchmarkSeries.directVolTiming)
    expect(reference.doubleCostStrategy.daily).toEqual(actual.benchmarkSeries.doubleCostStrategy)
  })

  test('binds the result to raw market data', () => {
    const snapshot = makeSnapshot(900)
    const provenance = makeTestProvenance()
    const original = assertSuccess(evaluateReference(snapshot.bars, snapshot.manifest, fixtureProtocol, provenance))
    const bars = snapshot.bars.map((bar, index) => (index === 4_000 ? { ...bar, close: bar.close * 1.5 } : bar))
    const changed = assertSuccess(evaluateReference(bars, snapshot.manifest, fixtureProtocol, provenance))

    expect(canonicalHashV1(changed.strategy.decisions)).not.toBe(canonicalHashV1(original.strategy.decisions))
  })

  test('does not import the production strategy evaluator', async () => {
    const source = await Bun.file(new URL('./audit/reference.ts', import.meta.url)).text()

    expect(source).not.toContain("from '../risk-balanced-trend'")
    expect(source).not.toContain("from '../risk-balanced-trend/index'")
    expect(source).not.toContain('evaluateRiskBalancedTrend')
  })

  test('independently keeps planned quantities invariant to future execution OHLC', () => {
    const snapshot = makeSnapshot(900)
    const provenance = makeTestProvenance()
    const actual = assertSuccess(
      evaluateRiskBalancedTrend(snapshot.bars, snapshot.manifest, fixtureProtocol, provenance),
    )
    const executionDate = actual.signalDecisions[0].executionDate
    const changedBars = snapshot.bars.map((bar) => {
      if (bar.sessionDate !== executionDate) return bar
      const open = bar.open * 1.5
      const close = bar.close * 1.2
      return {
        ...bar,
        open,
        high: Math.max(open, close, bar.high * 1.1),
        low: Math.min(open, close, bar.low * 0.8),
        close,
      }
    })
    const changedActual = assertSuccess(
      evaluateRiskBalancedTrend(changedBars, snapshot.manifest, fixtureProtocol, provenance),
    )
    const changedReference = assertSuccess(
      evaluateReference(changedBars, snapshot.manifest, fixtureProtocol, provenance),
    )
    const requests = (orders: typeof actual.simulation.orders) =>
      orders
        .filter((order) => order.sessionDate === executionDate)
        .map(({ decisionId, sessionDate, symbol, side, requestedQuantityMicros }) => ({
          decisionId,
          sessionDate,
          symbol,
          side,
          requestedQuantityMicros,
        }))

    expect(requests(changedActual.simulation.orders)).toEqual(requests(actual.simulation.orders))
    expect(requests(changedReference.strategy.trace?.orders ?? [])).toEqual(requests(actual.simulation.orders))
    expect(changedActual.strategy.endingEquityMicros).not.toBe(actual.strategy.endingEquityMicros)
    expect(changedReference.strategy.trace).toEqual(changedActual.simulation)
  })

  test('uses immutable replay transitions with linear state-copy work at realistic history size', () => {
    const snapshot = makeSnapshot(900)
    const provenance = makeTestProvenance()
    const before = canonicalHashV1({ bars: snapshot.bars, manifest: snapshot.manifest, protocol: fixtureProtocol })
    const first = assertSuccess(
      measureReferenceEvaluationWork(snapshot.bars, snapshot.manifest, fixtureProtocol, provenance),
    )
    const second = assertSuccess(
      measureReferenceEvaluationWork(snapshot.bars, snapshot.manifest, fixtureProtocol, provenance),
    )

    expect(snapshot.bars).toHaveLength(900 * fixtureProtocol.universe.length)
    for (const replay of [first.strategy, first.buyAndHold, first.directVolTiming, first.doubleCostStrategy]) {
      expect(replay.positionStateCopies).toBeLessThanOrEqual(replay.sessionsProcessed)
      expect(replay.positionWrites).toBeLessThanOrEqual(replay.sessionsProcessed * fixtureProtocol.universe.length * 2)
    }
    expect(second).toEqual(first)
    expect(canonicalHashV1({ bars: snapshot.bars, manifest: snapshot.manifest, protocol: fixtureProtocol })).toBe(
      before,
    )
  })

  test('returns fact-bearing failures for malformed reference inputs', () => {
    const snapshot = makeSnapshot(900)
    const provenance = makeTestProvenance()

    expect(
      assertFailure(evaluateReference(snapshot.bars.slice(1), snapshot.manifest, fixtureProtocol, provenance)),
    ).toEqual({
      _tag: 'ReferenceInputRowCountMismatch',
      expected: snapshot.manifest.rowCount,
      actual: snapshot.bars.length - 1,
    })

    const unexpectedBars = snapshot.bars.map((bar, index) => (index === 0 ? { ...bar, symbol: 'UNEXPECTED' } : bar))
    expect(assertFailure(evaluateReference(unexpectedBars, snapshot.manifest, fixtureProtocol, provenance))._tag).toBe(
      'ReferenceUnexpectedSymbol',
    )

    const duplicateBars = snapshot.bars.map((bar, index) =>
      index === 1 ? { ...bar, symbol: snapshot.bars[0].symbol } : bar,
    )
    expect(assertFailure(evaluateReference(duplicateBars, snapshot.manifest, fixtureProtocol, provenance))._tag).toBe(
      'ReferenceDuplicateBar',
    )

    const incompleteBars = snapshot.bars.map((bar, index) =>
      index === 0 ? { ...bar, sessionDate: '1990-01-01' as typeof bar.sessionDate } : bar,
    )
    expect(assertFailure(evaluateReference(incompleteBars, snapshot.manifest, fixtureProtocol, provenance))._tag).toBe(
      'ReferenceIncompleteSession',
    )

    expect(
      assertFailure(
        evaluateReference(
          snapshot.bars,
          { ...snapshot.manifest, sessionCount: snapshot.manifest.sessionCount + 1 },
          fixtureProtocol,
          provenance,
        ),
      )._tag,
    ).toBe('ReferenceManifestSessionMismatch')
  })

  test('returns fact-bearing failures for invalid reference protocol decisions', () => {
    const snapshot = makeSnapshot(900)

    const covarianceProtocol = { ...fixtureProtocol, volatilityWindow: 1 }
    expect(
      assertFailure(
        evaluateReference(snapshot.bars, snapshot.manifest, covarianceProtocol, makeTestProvenance(covarianceProtocol)),
      )._tag,
    ).toBe('ReferenceCovarianceInputMismatch')

    const horizonProtocol = { ...fixtureProtocol, horizons: [0] }
    expect(
      assertFailure(
        evaluateReference(snapshot.bars, snapshot.manifest, horizonProtocol, makeTestProvenance(horizonProtocol)),
      )._tag,
    ).toBe('ReferenceInvalidHorizonSignal')

    const scoreProtocol = { ...fixtureProtocol, horizons: [] }
    expect(
      assertFailure(
        evaluateReference(snapshot.bars, snapshot.manifest, scoreProtocol, makeTestProvenance(scoreProtocol)),
      )._tag,
    ).toBe('ReferenceInvalidScore')

    const weightProtocol = { ...fixtureProtocol, maximumSymbolWeight: -0.1 }
    expect(
      assertFailure(
        evaluateReference(snapshot.bars, snapshot.manifest, weightProtocol, makeTestProvenance(weightProtocol)),
      )._tag,
    ).toBe('ReferenceInvalidWeight')

    const insufficientProtocol = {
      ...fixtureProtocol,
      thresholds: { ...fixtureProtocol.thresholds, minimumObservations: 100_000 },
    }
    expect(
      assertFailure(
        evaluateReference(
          snapshot.bars,
          snapshot.manifest,
          insufficientProtocol,
          makeTestProvenance(insufficientProtocol),
        ),
      )._tag,
    ).toBe('ReferenceInsufficientObservations')
  })

  test('fails closed on invalid market values, provenance, and execution-model versions', () => {
    const snapshot = makeSnapshot(900)
    const invalidCloseBars = snapshot.bars.map((bar, index) => (index === 4_000 ? { ...bar, close: 0 } : bar))
    expect(
      assertFailure(evaluateReference(invalidCloseBars, snapshot.manifest, fixtureProtocol, makeTestProvenance()))._tag,
    ).toBe('ReferenceInvalidClose')

    const changedProvenance = {
      ...makeTestProvenance(),
      strategy: { ...makeTestProvenance().strategy, parameterHash: '0'.repeat(64) },
    }
    expect(
      assertFailure(evaluateReference(snapshot.bars, snapshot.manifest, fixtureProtocol, changedProvenance))._tag,
    ).toBe('ReferenceProvenanceMismatch')

    const noSignalManifest = {
      ...snapshot.manifest,
      bounds: {
        ...snapshot.manifest.bounds,
        evaluationStart: snapshot.manifest.firstSession,
        evaluationEnd: snapshot.manifest.firstSession,
      },
    }
    expect(
      assertFailure(evaluateReference(snapshot.bars, noSignalManifest, fixtureProtocol, makeTestProvenance()))._tag,
    ).toBe('ReferenceNoEligibleSignal')

    const unsupportedProtocol = {
      ...fixtureProtocol,
      executionModel: { ...fixtureProtocol.executionModel, schemaVersion: 'bayn.execution-model.v1' },
    } as unknown as typeof fixtureProtocol
    expect(
      assertFailure(
        evaluateReference(
          snapshot.bars,
          snapshot.manifest,
          unsupportedProtocol,
          makeTestProvenance(unsupportedProtocol),
        ),
      ),
    ).toEqual({
      _tag: 'UnsupportedReferenceExecutionModel',
      actual: 'bayn.execution-model.v1',
      required: 'bayn.execution-model.v2',
    })
  })

  test('rejects a buying-power adjustment that increases a modeled fill', () => {
    const order = {
      id: '1'.repeat(64),
      decisionId: '2'.repeat(64),
      sessionDate: '2026-07-21' as const,
      symbol: fixtureProtocol.universe[0],
      side: 'buy' as const,
      requestedQuantityMicros: '100',
      filledQuantityMicros: '80',
      status: 'partially-filled' as const,
      rejectionReason: null,
      unfilledRemainder: 'canceled' as const,
    }

    expect(assertFailure(restrictReferenceBuyFill('3'.repeat(64), order, 81n))).toEqual({
      _tag: 'ReferenceBuyFillRestrictionInvalid',
      orderId: order.id,
      modeledQuantityMicros: '80',
      permittedQuantityMicros: '81',
    })
  })
})
