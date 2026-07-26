import assert from 'node:assert/strict'

import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { makeQualificationResult } from '../../qualification'
import { evaluateRiskBalancedTrend } from '../../risk-balanced-trend'
import { makeStrategy } from '../../strategy'
import { fixtureProtocol, makeSnapshot, makeTestProvenance } from '../../test-fixtures'
import {
  decodeQualificationRecord,
  validateQualificationOpenInput,
  type QualificationRowPayload,
} from './qualification'

const successOf = <A, E>(result: Result.Result<A, E>): A => {
  assert(Result.isSuccess(result), 'fixture Result must succeed')
  return result.success
}

const makeFixture = (sourceRevision = 'a'.repeat(40)) => {
  const snapshot = makeSnapshot(800)
  const provenance = makeTestProvenance(fixtureProtocol, { sourceRevision })
  const evaluation = successOf(evaluateRiskBalancedTrend(snapshot.bars, snapshot.manifest, fixtureProtocol, provenance))
  const sessionDates = [...new Set(snapshot.bars.map((bar) => bar.sessionDate))].sort()
  const strategy = makeStrategy(fixtureProtocol, provenance)
  const lock = successOf(strategy.prepareLock(evaluation.inputManifest, sessionDates, []))
  const analysis = successOf(strategy.analyze(evaluation, []))
  const result = successOf(makeQualificationResult(lock, evaluation.verdict, analysis))
  return {
    open: {
      lock,
      inputManifest: evaluation.inputManifest,
      parameters: fixtureProtocol,
      provenance,
    },
    lock,
    result,
  }
}

describe('EvidenceStore qualification decisions', () => {
  test('accepts the exact source, image, protocol, snapshot, and manifest binding', () => {
    const fixture = makeFixture()
    expect(validateQualificationOpenInput(fixture.open)).toEqual(Result.succeed(fixture.open))
  })

  test('returns facts for every former open-input TypeError invariant', () => {
    const fixture = makeFixture()
    const other = makeFixture('b'.repeat(40))
    const parameterFailure = validateQualificationOpenInput({
      ...fixture.open,
      parameters: { ...fixture.open.parameters, initialCapitalMicros: '1' },
    })
    const manifestFailure = validateQualificationOpenInput({
      ...fixture.open,
      inputManifest: { ...fixture.open.inputManifest, hash: 'f'.repeat(64) },
    })
    const lockFailure = validateQualificationOpenInput({ ...fixture.open, lock: other.lock })

    expect(parameterFailure).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'QualificationMismatch',
        stage: 'open-input',
        path: ['provenance', 'strategy', 'parameterHash'],
      },
    })
    expect(manifestFailure).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'QualificationMismatch',
        stage: 'open-input',
        path: ['inputManifest', 'hash'],
        observed: 'f'.repeat(64),
      },
    })
    expect(lockFailure).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'QualificationMismatch',
        stage: 'open-input',
        path: ['lock', 'candidateRunId'],
      },
    })
  })

  test('returns a closed stored-result lineage failure instead of throwing', () => {
    const fixture = makeFixture()
    const other = makeFixture('b'.repeat(40))
    const row: QualificationRowPayload = {
      lock_payload: fixture.lock,
      result_payload: other.result,
    }

    expect(decodeQualificationRecord(row)).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'QualificationMismatch',
        stage: 'stored-record',
        path: ['result', 'lockId'],
        observed: other.result.lockId,
        expected: fixture.lock.lockId,
      },
    })

    expect(
      decodeQualificationRecord({
        lock_payload: fixture.lock,
        result_payload: { ...fixture.result, runId: other.lock.candidateRunId },
      }),
    ).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'QualificationMismatch',
        stage: 'stored-record',
        path: ['result', 'runId'],
        observed: other.lock.candidateRunId,
        expected: fixture.lock.candidateRunId,
      },
    })
  })
})
