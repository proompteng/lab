import assert from 'node:assert/strict'

import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { evaluateReference } from '../audit/reference'
import { fixtureSnapshot, fixtureRuntime } from '../app-test-support'
import { evaluateRiskBalancedTrend } from '../risk-balanced-trend'
import { evaluateStrategyApplication, hashEvaluationTargets, hashStrategyEvaluation } from './evaluation-runner'

const assertSuccess = <A, E>(result: Result.Result<A, E>): A => {
  assert(Result.isSuccess(result), 'evaluation fixture must succeed')
  return result.success
}

describe('strategy definition evaluation runner', () => {
  test('development and qualification produce identical target and evaluation hashes', () => {
    const development = assertSuccess(
      evaluateRiskBalancedTrend(
        fixtureSnapshot.bars,
        fixtureSnapshot.manifest,
        fixtureRuntime.definition.parameters,
        fixtureRuntime.provenance,
        fixtureRuntime.definition,
      ),
    )
    const qualification = assertSuccess(
      evaluateStrategyApplication({
        application: fixtureRuntime.application,
        provenance: fixtureRuntime.provenance,
        bars: fixtureSnapshot.bars,
        inputManifest: fixtureSnapshot.manifest,
      }),
    )

    expect(assertSuccess(hashEvaluationTargets(development))).toBe(assertSuccess(hashEvaluationTargets(qualification)))
    expect(assertSuccess(hashStrategyEvaluation(development))).toBe(
      assertSuccess(hashStrategyEvaluation(qualification)),
    )
  })

  test('applies the terminal liquidation boundary to both benchmark simulations', () => {
    const actual = assertSuccess(
      evaluateStrategyApplication({
        application: fixtureRuntime.application,
        provenance: fixtureRuntime.provenance,
        bars: fixtureSnapshot.bars,
        inputManifest: fixtureSnapshot.manifest,
      }),
    )
    const closedReference = assertSuccess(
      evaluateReference(
        fixtureSnapshot.bars,
        fixtureSnapshot.manifest,
        fixtureRuntime.definition.parameters,
        fixtureRuntime.provenance,
        true,
      ),
    )
    const openReference = assertSuccess(
      evaluateReference(
        fixtureSnapshot.bars,
        fixtureSnapshot.manifest,
        fixtureRuntime.definition.parameters,
        fixtureRuntime.provenance,
        false,
      ),
    )

    expect(actual.buyAndHold).toEqual(closedReference.buyAndHold.metrics)
    expect(actual.directVolTiming).toEqual(closedReference.directVolTiming.metrics)
    expect(closedReference.buyAndHold.metrics.totalFeesMicros).not.toBe(
      openReference.buyAndHold.metrics.totalFeesMicros,
    )
    expect(closedReference.directVolTiming.metrics.totalFeesMicros).not.toBe(
      openReference.directVolTiming.metrics.totalFeesMicros,
    )
  })
})
