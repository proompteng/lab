import assert from 'node:assert/strict'

import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import {
  decideQualificationTerminal,
  makeQualificationLock,
  makeQualificationPolicyDocument,
  makeQualificationResult,
  runQualificationPipeline,
  type QualificationResult,
  type QualificationTerminalConflict,
  type QualificationTerminalState,
} from '../qualification'
import { defaultQualificationStatisticsPolicy, prepareQualificationSeries } from '../qualification-statistics'
import { makeStrategy } from '../strategy'
import { fixtureProtocol, makeSnapshot, makeTestProvenance } from '../test-fixtures'

const successOf = <A, E>(result: Result.Result<A, E>): A => {
  assert(Result.isSuccess(result), 'qualification fixture must succeed')
  return result.success
}

const fixture = () => {
  const snapshot = makeSnapshot(900)
  const strategy = makeStrategy(fixtureProtocol, makeTestProvenance())
  const evaluation = successOf(strategy.evaluate(snapshot.bars, snapshot.manifest))
  const sessionDates = [...new Set(snapshot.bars.map((bar) => bar.sessionDate))].sort()
  const lock = successOf(strategy.prepareLock(snapshot.manifest, sessionDates, []))
  const series = successOf(prepareQualificationSeries(evaluation))
  const evidence = successOf(
    runQualificationPipeline({
      lock,
      evaluationVerdict: evaluation.verdict,
      series,
    }),
  )
  return { evidence, evaluation, lock, series }
}

class TerminalInterpreter {
  private state: QualificationTerminalState
  writes = 0

  constructor(state: QualificationTerminalState) {
    this.state = state
  }

  commit(result: QualificationResult): Result.Result<QualificationResult, QualificationTerminalConflict> {
    const decision = decideQualificationTerminal(this.state, result)
    if (Result.isFailure(decision)) return Result.fail(decision.failure)
    if (decision.success.action === 'WRITE_TERMINAL') {
      this.writes += 1
      this.state = { state: 'TERMINAL', lock: decision.success.lock, result: decision.success.result }
    }
    return Result.succeed(decision.success.result)
  }
}

describe('qualification one-shot terminal integration', () => {
  test('constructs the same typed analysis and receipt through the explicit pipeline', () => {
    const { evidence, evaluation, lock } = fixture()
    const directAnalysis = successOf(makeStrategy(fixtureProtocol, makeTestProvenance()).analyze(evaluation, []))
    const directResult = successOf(makeQualificationResult(lock, evaluation.verdict, directAnalysis))

    expect(evidence.analysis).toEqual(directAnalysis)
    expect(evidence.result).toEqual(directResult)
    expect(evidence.lock).toBe(lock)
  })

  test('derives the exact statistical policy exclusively from the immutable lock', () => {
    const { evaluation, lock, series } = fixture()
    const tunedPolicy = {
      ...defaultQualificationStatisticsPolicy,
      bootstrap: { ...defaultQualificationStatisticsPolicy.bootstrap, samples: 1_000 },
    } as const
    const uncertainty = successOf(makeQualificationPolicyDocument(tunedPolicy.schemaVersion, tunedPolicy))
    const { lockId: _, ...lockMaterial } = lock
    const tunedLock = successOf(
      makeQualificationLock({
        ...lockMaterial,
        policies: { ...lockMaterial.policies, uncertainty },
      }),
    )

    const evidence = successOf(
      runQualificationPipeline({
        lock: tunedLock,
        evaluationVerdict: evaluation.verdict,
        series,
      }),
    )

    expect(evidence.analysis.policy).toEqual(tunedPolicy)
    expect(evidence.lock.lockId).toBe(tunedLock.lockId)
    expect(evidence.lock.lockId).not.toBe(lock.lockId)
  })

  test('rejects malformed statistics content even when it is hash-bound by the lock', () => {
    const { evaluation, lock, series } = fixture()
    const malformedPolicy = {
      ...defaultQualificationStatisticsPolicy,
      bootstrap: { ...defaultQualificationStatisticsPolicy.bootstrap, samples: 999 },
    }
    const uncertainty = successOf(
      makeQualificationPolicyDocument(defaultQualificationStatisticsPolicy.schemaVersion, malformedPolicy),
    )
    const { lockId: _, ...lockMaterial } = lock
    const mismatchedLock = successOf(
      makeQualificationLock({
        ...lockMaterial,
        policies: { ...lockMaterial.policies, uncertainty },
      }),
    )

    const result = runQualificationPipeline({
      lock: mismatchedLock,
      evaluationVerdict: evaluation.verdict,
      series,
    })
    assert(Result.isFailure(result), 'malformed locked statistics policy must fail')
    expect(result.failure._tag).toBe('QualificationStatisticsSchemaInvalid')
    if (result.failure._tag === 'QualificationStatisticsSchemaInvalid') {
      expect(result.failure.operation).toBe('policy')
    }
  })

  test('writes one terminal result, replays the same receipt, and rejects a divergent second write', () => {
    const { evidence, lock } = fixture()
    const interpreter = new TerminalInterpreter({ state: 'PREREGISTERED', lock })

    expect(successOf(interpreter.commit(evidence.result))).toEqual(evidence.result)
    expect(successOf(interpreter.commit(structuredClone(evidence.result)))).toEqual(evidence.result)
    expect(interpreter.writes).toBe(1)

    const divergent = { ...evidence.result, resultHash: 'f'.repeat(64) }
    expect(interpreter.commit(divergent)).toEqual(
      Result.fail({
        _tag: 'QualificationTerminalResultConflict',
        committedResultHash: evidence.result.resultHash,
        attemptedResultHash: divergent.resultHash,
      }),
    )
    expect(interpreter.writes).toBe(1)
  })
})
