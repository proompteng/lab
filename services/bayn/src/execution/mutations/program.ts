import { PgClient } from '@effect/sql-pg'
import { Effect, Layer } from 'effect'

import { MutationOperation } from '../../broker/alpaca-mutations'
import { storeError } from './decisions'
import { MutationStore, MutationStoreError, type MutationStoreShape } from './model'
import { makeMutationEventPostgres } from './postgres/events'
import { makeMutationOutcomePostgres } from './postgres/outcome'
import { makeMutationStartPostgres } from './postgres/start'
import { WriterFence, WriterFenceError } from '../writer-fence'

export const makePostgresMutationStore = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const fence = yield* WriterFence
  const events = makeMutationEventPostgres(sql)
  const start = makeMutationStartPostgres(sql, fence, events)
  const outcome = makeMutationOutcomePostgres(sql, fence, events)

  const run = <A, E, R>(
    operation: MutationStoreError['operation'],
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, MutationStoreError | WriterFenceError, R> =>
    effect.pipe(
      Effect.mapError((cause) =>
        cause instanceof MutationStoreError || cause instanceof WriterFenceError
          ? cause
          : storeError({ operation, failure: 'query', message: `mutation ${operation} failed`, cause }),
      ),
    )

  const appendOutcome = outcome.appendOutcome

  return {
    authorizeSubmit: (intentId, closeOnly) => run('begin-submit', start.authorizeSubmit(intentId, closeOnly)),
    beginSubmit: (intentId, requestHash, consistencyDelayMs, occurredAt, closeOnly) =>
      run(
        'begin-submit',
        start.begin(
          MutationOperation.Submit,
          intentId,
          requestHash,
          consistencyDelayMs,
          occurredAt,
          undefined,
          closeOnly,
        ),
      ),
    submitAccepted: (intentId, requestHash, brokerOrderId, evidence, terminalOutcome) =>
      run(
        'record-submit',
        appendOutcome(
          {
            _tag: 'SubmitAccepted',
            ...(terminalOutcome === undefined ? {} : { terminalOutcome }),
          },
          intentId,
          requestHash,
          evidence.observedAt,
          evidence,
          brokerOrderId,
        ),
      ),
    submitRejected: (intentId, requestHash, evidence) =>
      run(
        'record-submit',
        appendOutcome({ _tag: 'SubmitRejected' }, intentId, requestHash, evidence.observedAt, evidence),
      ),
    submitDenied: (intentId, requestHash, occurredAt) =>
      run('record-submit', appendOutcome({ _tag: 'SubmitDenied' }, intentId, requestHash, occurredAt)),
    submitUnknown: (intentId, requestHash, occurredAt, evidence, brokerOrderId) =>
      run(
        'record-submit',
        appendOutcome({ _tag: 'SubmitUnknown' }, intentId, requestHash, occurredAt, evidence, brokerOrderId),
      ),
    beginCancel: (intentId, requestHash, brokerOrderId, consistencyDelayMs, occurredAt) =>
      run(
        'begin-cancel',
        start.begin(MutationOperation.Cancel, intentId, requestHash, consistencyDelayMs, occurredAt, brokerOrderId),
      ),
    cancelAccepted: (intentId, requestHash, brokerOrderId, evidence) =>
      run(
        'record-cancel',
        appendOutcome({ _tag: 'CancelAccepted' }, intentId, requestHash, evidence.observedAt, evidence, brokerOrderId),
      ),
    cancelUnknown: (intentId, requestHash, brokerOrderId, occurredAt, evidence) =>
      run(
        'record-cancel',
        appendOutcome({ _tag: 'CancelUnknown' }, intentId, requestHash, occurredAt, evidence, brokerOrderId),
      ),
    recoveryFound: (intentId, operation, requestHash, brokerOrderId, evidence, terminalOutcome) =>
      run(
        'record-recovery',
        appendOutcome(
          {
            _tag: 'RecoveryFound',
            operation,
            ...(terminalOutcome === undefined ? {} : { terminalOutcome }),
          },
          intentId,
          requestHash,
          evidence.observedAt,
          evidence,
          brokerOrderId,
        ),
      ),
    recoveryNotFound: (intentId, operation, requestHash, evidence) =>
      run(
        'record-recovery',
        appendOutcome({ _tag: 'RecoveryNotFound', operation }, intentId, requestHash, evidence.observedAt, evidence),
      ),
    recoveryUnknown: (intentId, operation, requestHash, occurredAt, evidence) =>
      run(
        'record-recovery',
        appendOutcome({ _tag: 'RecoveryUnknown', operation }, intentId, requestHash, occurredAt, evidence),
      ),
    latest: events.latest,
  } satisfies MutationStoreShape
})

export const MutationStoreLive = Layer.effect(MutationStore, makePostgresMutationStore)
