import { Effect, Option, Result } from 'effect'

import { renderEvidenceRecoveryIssue, type EvidenceRecoveryIssue } from '../evidence-recovery'
import { databaseError, ensure, type DatabaseError } from './errors'
import type { QualificationRecord } from './model'
import { renderPersistencePlanFailure } from './persistence-failures'
import type { PersistencePlanFailure } from './persistence-model'
import {
  decodeQualificationRecord,
  renderQualificationDecisionFailure,
  type QualificationDecisionFailure,
} from './qualification'
import type { DecodedQualificationRow } from './qualification-statements'

export const persistencePlanDatabaseError = (operation: string, failure: PersistencePlanFailure) =>
  databaseError(
    'invariant',
    operation,
    renderPersistencePlanFailure(failure),
    failure._tag === 'SimulationReconciliationFailed' ? failure.issues : failure,
  )

export const liftPersistenceResult = <A>(
  operation: string,
  result: Result.Result<A, PersistencePlanFailure>,
): Effect.Effect<A, DatabaseError> =>
  Effect.fromResult(result).pipe(Effect.mapError((failure) => persistencePlanDatabaseError(operation, failure)))

export const liftQualificationResult = <A>(
  operation: string,
  result: Result.Result<A, QualificationDecisionFailure>,
): Effect.Effect<A, DatabaseError> =>
  Effect.fromResult(result).pipe(
    Effect.mapError((cause) => databaseError('invariant', operation, renderQualificationDecisionFailure(cause), cause)),
  )

const recoveryIssueDatabaseError = (operation: string, issue: EvidenceRecoveryIssue): DatabaseError =>
  databaseError(
    issue._tag === 'DecodeFailure' ? 'decode' : 'invariant',
    operation,
    renderEvidenceRecoveryIssue(issue),
    issue._tag === 'SimulationFailure' ? issue.issues : issue,
  )

export const liftRecoveryResult = <A>(
  operation: string,
  result: Result.Result<A, EvidenceRecoveryIssue>,
): Effect.Effect<A, DatabaseError> =>
  Effect.fromResult(result).pipe(Effect.mapError((issue) => recoveryIssueDatabaseError(operation, issue)))

export const decodeSingleQualification = (
  rows: readonly DecodedQualificationRow[],
  operation: string,
): Effect.Effect<Option.Option<QualificationRecord>, DatabaseError> =>
  Effect.gen(function* () {
    if (rows.length === 0) return Option.none<QualificationRecord>()
    yield* ensure(rows.length === 1, operation, 'qualification identity is duplicated or divergent')
    const row = rows[0]
    if (row === undefined) {
      return yield* Effect.fail(databaseError('invariant', operation, 'qualification row disappeared'))
    }
    const record = yield* Effect.fromResult(decodeQualificationRecord(row)).pipe(
      Effect.mapError((cause) =>
        databaseError('invariant', operation, renderQualificationDecisionFailure(cause), cause),
      ),
    )
    return Option.some(record)
  })
