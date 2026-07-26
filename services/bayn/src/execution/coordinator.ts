import { Clock, Data, Effect, Match, Result } from 'effect'

import { BrokerMutation, MutationOperation } from '../broker/alpaca-mutations'
import { BrokerRead } from '../broker/alpaca'
import { IntentState, type Intent } from '../paper'
import {
  cancellationIdentity,
  decideCancelFailure,
  decideCancelSuccess,
  decideInterruptedStart,
  decideRecoveryFailure,
  decideRecoverySuccess,
  decideSubmitFailure,
  decideSubmitSuccess,
  encodeOrder,
  ensureRecoveryDelay,
  makeDryRunSubmit,
  nextInstant,
  selectRecovery,
  selectStoredIntent,
  validateActiveSubmitRiskDecision,
  validateRecovery,
  type CancelPersistenceDecision,
  type DryRunSubmitDecision,
  type ExecutionDecisionFailure,
  type RecoveryPersistenceDecision,
  type SubmitPersistenceDecision,
} from './coordinator-decisions'
import { IntentStore, type IntentStoreError, type StoredIntent } from './intents/domain'
import { MutationStore, type MutationEvent } from './mutations'
import { WriterFence } from './writer-fence'
import { currentUtcInstant, utcInstantFromEpochMillis } from '../time'

export enum ExecutionFailure {
  IntentNotFound = 'INTENT_NOT_FOUND',
  InvalidState = 'INVALID_STATE',
  RecoveryTooEarly = 'RECOVERY_TOO_EARLY',
}

export class ExecutionError extends Data.TaggedError('ExecutionError')<{
  readonly operation: MutationOperation
  readonly failure: ExecutionFailure
  readonly message: string
  readonly eligibleAt?: string
  readonly cause?: unknown
}> {}

export interface DryRunSubmit extends DryRunSubmitDecision {}

interface MutationServices {
  readonly mutations: MutationStore['Service']
  readonly broker: BrokerMutation['Service']
  readonly fence: WriterFence['Service']
}

interface RecoveryServices {
  readonly mutations: MutationStore['Service']
  readonly broker: BrokerRead['Service']
}

const currentInstant = currentUtcInstant

const executionError = (failure: ExecutionDecisionFailure): ExecutionError =>
  Match.value(failure).pipe(
    Match.tagsExhaustive({
      IntentMissing: ({ operation, intentId }) =>
        new ExecutionError({
          operation,
          failure: ExecutionFailure.IntentNotFound,
          message: `intent ${intentId} does not exist`,
        }),
      InvalidRiskDecision: ({ operationLabel }) =>
        new ExecutionError({
          operation: MutationOperation.Submit,
          failure: ExecutionFailure.InvalidState,
          message: `${operationLabel} requires one committed approved intent and matching risk decision`,
        }),
      ExpiredRiskDecision: ({ operationLabel, expiresAt }) =>
        new ExecutionError({
          operation: MutationOperation.Submit,
          failure: ExecutionFailure.InvalidState,
          message: `${operationLabel} risk decision expired at ${expiresAt}`,
        }),
      OrderCanonicalizationFailed: ({ operation, message, cause }) =>
        new ExecutionError({
          operation,
          failure: ExecutionFailure.InvalidState,
          message,
          cause,
        }),
      CancellationOrderMissing: () =>
        new ExecutionError({
          operation: MutationOperation.Cancel,
          failure: ExecutionFailure.InvalidState,
          message: 'cancellation requires a positively identified broker order',
        }),
      MutationMissing: ({ operation }) =>
        new ExecutionError({
          operation,
          failure: ExecutionFailure.InvalidState,
          message: 'mutation does not exist',
        }),
      SubmitRecoveryBlockedByCancellation: () =>
        new ExecutionError({
          operation: MutationOperation.Submit,
          failure: ExecutionFailure.InvalidState,
          message: 'submit recovery requires the durable cancellation to recover first',
        }),
      InvalidRecovery: ({ operation }) =>
        new ExecutionError({
          operation,
          failure: ExecutionFailure.InvalidState,
          message: 'durable mutation identity or intent state does not permit broker recovery',
        }),
      RecoveryTooEarly: ({ operation, eligibleAt }) =>
        new ExecutionError({
          operation,
          failure: ExecutionFailure.RecoveryTooEarly,
          message: `broker lookup is not allowed before ${eligibleAt}`,
          eligibleAt,
        }),
      InvalidInstant: ({ operation, field, value }) =>
        new ExecutionError({
          operation,
          failure: ExecutionFailure.InvalidState,
          message: `execution coordinator ${field} instant is invalid: ${value}`,
        }),
    }),
  )

const liftDecision = <A>(decision: Result.Result<A, ExecutionDecisionFailure>): Effect.Effect<A, ExecutionError> =>
  Effect.fromResult(decision).pipe(Effect.mapError(executionError))

const readIntent = (
  operation: MutationOperation,
  intentId: string,
): Effect.Effect<StoredIntent, ExecutionError | IntentStoreError, IntentStore> =>
  Effect.flatMap(IntentStore, (store) =>
    store
      .read(intentId)
      .pipe(Effect.flatMap((stored) => liftDecision(selectStoredIntent(operation, intentId, stored)))),
  )

const requireActiveSubmitRiskDecision = (
  stored: StoredIntent,
  operationLabel = 'submission',
): Effect.Effect<StoredIntent, ExecutionError> =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((currentTimeMillis) =>
      liftDecision(validateActiveSubmitRiskDecision(stored, currentTimeMillis, operationLabel)),
    ),
  )

export const dryRunSubmit = (
  intentId: string,
): Effect.Effect<DryRunSubmit, ExecutionError | IntentStoreError, IntentStore> =>
  readIntent(MutationOperation.Submit, intentId).pipe(
    Effect.flatMap((stored) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((currentTimeMillis) => liftDecision(makeDryRunSubmit(stored, currentTimeMillis))),
      ),
    ),
  )

const persistSubmitDecision = (
  services: MutationServices,
  intentId: string,
  requestHash: string,
  decision: SubmitPersistenceDecision,
) =>
  Match.value(decision).pipe(
    Match.tagsExhaustive({
      SubmitAccepted: ({ brokerOrderId, evidence, terminalOutcome }) =>
        services.mutations.submitAccepted(intentId, requestHash, brokerOrderId, evidence, terminalOutcome),
      SubmitRejected: ({ evidence }) => services.mutations.submitRejected(intentId, requestHash, evidence),
      SubmitUnknown: ({ brokerOrderId, evidence }) =>
        (evidence === undefined ? currentInstant : Effect.succeed(evidence.observedAt)).pipe(
          Effect.flatMap((occurredAt) =>
            services.mutations.submitUnknown(intentId, requestHash, occurredAt, evidence, brokerOrderId),
          ),
        ),
    }),
  )

const submitToBroker = (
  services: MutationServices,
  stored: StoredIntent,
  requestHash: string,
  request: DryRunSubmitDecision['request'],
) => {
  const submittedIntent: Intent = { ...stored.intent, state: IntentState.IoStarted }
  return services.broker.submit(submittedIntent).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        persistSubmitDecision(services, stored.intent.intentId, requestHash, decideSubmitFailure(requestHash, error)),
      onSuccess: (receipt) =>
        persistSubmitDecision(
          services,
          stored.intent.intentId,
          requestHash,
          decideSubmitSuccess(submittedIntent, { requestHash, request }, receipt),
        ),
    }),
  )
}

const startSubmit = (
  services: MutationServices,
  stored: StoredIntent,
  requestHash: string,
  request: DryRunSubmitDecision['request'],
  consistencyDelayMs: number,
) =>
  services.fence.check.pipe(
    Effect.andThen(requireActiveSubmitRiskDecision(stored)),
    Effect.andThen(currentInstant),
    Effect.flatMap((occurredAt) =>
      liftDecision(nextInstant(MutationOperation.Submit, stored.updatedAt, occurredAt)).pipe(
        Effect.flatMap((nextOccurredAt) =>
          services.mutations.beginSubmit(stored.intent.intentId, requestHash, consistencyDelayMs, nextOccurredAt),
        ),
      ),
    ),
    Effect.flatMap((started) =>
      started.started ? submitToBroker(services, stored, requestHash, request) : Effect.succeed(started.event),
    ),
  )

const runSubmit = (services: MutationServices, intentId: string, consistencyDelayMs: number) =>
  services.mutations
    .latest(intentId, MutationOperation.Submit)
    .pipe(
      Effect.flatMap((existing) =>
        readIntent(MutationOperation.Submit, intentId).pipe(
          Effect.flatMap((stored) =>
            liftDecision(encodeOrder(MutationOperation.Submit, stored.intent)).pipe(
              Effect.flatMap(({ request, requestHash }) =>
                existing === undefined
                  ? startSubmit(services, stored, requestHash, request, consistencyDelayMs)
                  : services.mutations
                      .beginSubmit(intentId, requestHash, consistencyDelayMs, existing.occurredAt)
                      .pipe(Effect.map(({ event }) => event)),
              ),
            ),
          ),
        ),
      ),
    )

export const submit = (intentId: string, consistencyDelayMs: number) =>
  Effect.all({
    mutations: MutationStore,
    broker: BrokerMutation,
    fence: WriterFence,
  }).pipe(Effect.flatMap((services) => runSubmit(services, intentId, consistencyDelayMs)))

const persistCancelDecision = (
  services: MutationServices,
  intentId: string,
  requestHash: string,
  brokerOrderId: string,
  decision: CancelPersistenceDecision,
) =>
  Match.value(decision).pipe(
    Match.tagsExhaustive({
      CancelAccepted: ({ evidence }) =>
        services.mutations.cancelAccepted(intentId, requestHash, brokerOrderId, evidence),
      CancelUnknown: ({ evidence }) =>
        (evidence === undefined ? currentInstant : Effect.succeed(evidence.observedAt)).pipe(
          Effect.flatMap((occurredAt) =>
            services.mutations.cancelUnknown(intentId, requestHash, brokerOrderId, occurredAt, evidence),
          ),
        ),
    }),
  )

const cancelAtBroker = (services: MutationServices, intentId: string, requestHash: string, brokerOrderId: string) =>
  services.broker.cancel(brokerOrderId).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        persistCancelDecision(services, intentId, requestHash, brokerOrderId, decideCancelFailure(error)),
      onSuccess: (receipt) =>
        persistCancelDecision(
          services,
          intentId,
          requestHash,
          brokerOrderId,
          decideCancelSuccess(brokerOrderId, requestHash, receipt),
        ),
    }),
  )

const startCancel = (
  services: MutationServices,
  stored: StoredIntent,
  requestHash: string,
  brokerOrderId: string,
  consistencyDelayMs: number,
) =>
  services.fence.check.pipe(
    Effect.andThen(currentInstant),
    Effect.flatMap((occurredAt) =>
      liftDecision(nextInstant(MutationOperation.Cancel, stored.updatedAt, occurredAt)).pipe(
        Effect.flatMap((nextOccurredAt) =>
          services.mutations.beginCancel(
            stored.intent.intentId,
            requestHash,
            brokerOrderId,
            consistencyDelayMs,
            nextOccurredAt,
          ),
        ),
      ),
    ),
    Effect.flatMap((started) =>
      started.started
        ? cancelAtBroker(services, stored.intent.intentId, requestHash, brokerOrderId)
        : Effect.succeed(started.event),
    ),
  )

const runCancel = (services: MutationServices, intentId: string, consistencyDelayMs: number) =>
  services.mutations
    .latest(intentId, MutationOperation.Cancel)
    .pipe(
      Effect.flatMap((existing) =>
        services.mutations
          .latest(intentId, MutationOperation.Submit)
          .pipe(
            Effect.flatMap((submitted) =>
              liftDecision(cancellationIdentity(submitted)).pipe(
                Effect.flatMap(({ brokerOrderId, requestHash }) =>
                  existing === undefined
                    ? readIntent(MutationOperation.Cancel, intentId).pipe(
                        Effect.flatMap((stored) =>
                          startCancel(services, stored, requestHash, brokerOrderId, consistencyDelayMs),
                        ),
                      )
                    : services.mutations
                        .beginCancel(intentId, requestHash, brokerOrderId, consistencyDelayMs, existing.occurredAt)
                        .pipe(Effect.map(({ event }) => event)),
                ),
              ),
            ),
          ),
      ),
    )

export const cancel = (intentId: string, consistencyDelayMs: number) =>
  Effect.all({
    mutations: MutationStore,
    broker: BrokerMutation,
    fence: WriterFence,
  }).pipe(Effect.flatMap((services) => runCancel(services, intentId, consistencyDelayMs)))

const markInterruptedStart = (mutations: MutationStore['Service'], event: MutationEvent, occurredAt: string) =>
  Match.value(decideInterruptedStart(event, occurredAt)).pipe(
    Match.tagsExhaustive({
      MarkSubmitUnknown: ({ event: started, occurredAt: interruptedAt }) =>
        mutations.submitUnknown(started.intentId, started.requestHash, interruptedAt),
      MarkCancelUnknown: ({ event: started, brokerOrderId, occurredAt: interruptedAt }) =>
        mutations.cancelUnknown(started.intentId, started.requestHash, brokerOrderId, interruptedAt),
      KeepMutation: ({ event: current }) => Effect.succeed(current),
    }),
  )

const persistRecoveryDecision = (
  services: RecoveryServices,
  intentId: string,
  operation: MutationOperation,
  requestHash: string,
  decision: RecoveryPersistenceDecision,
) =>
  Match.value(decision).pipe(
    Match.tagsExhaustive({
      RecoveryFound: ({ brokerOrderId, evidence, terminalOutcome }) =>
        services.mutations.recoveryFound(intentId, operation, requestHash, brokerOrderId, evidence, terminalOutcome),
      RecoveryNotFound: ({ evidence }) =>
        services.mutations.recoveryNotFound(intentId, operation, requestHash, evidence),
      RecoveryUnknown: ({ evidence }) =>
        (evidence === undefined ? currentInstant : Effect.succeed(evidence.observedAt)).pipe(
          Effect.flatMap((occurredAt) =>
            services.mutations.recoveryUnknown(intentId, operation, requestHash, occurredAt, evidence),
          ),
        ),
    }),
  )

const recoverAtBroker = (
  services: RecoveryServices,
  stored: StoredIntent,
  operation: MutationOperation,
  interrupted: MutationEvent,
) =>
  services.broker.orderByClientId(stored.intent.clientOrderId).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        persistRecoveryDecision(
          services,
          stored.intent.intentId,
          operation,
          interrupted.requestHash,
          decideRecoveryFailure(error),
        ),
      onSuccess: (result) =>
        persistRecoveryDecision(
          services,
          stored.intent.intentId,
          operation,
          interrupted.requestHash,
          decideRecoverySuccess(stored.intent, operation, interrupted, result),
        ),
    }),
  )

const continueRecovery = (
  services: RecoveryServices,
  stored: StoredIntent,
  operation: MutationOperation,
  event: MutationEvent,
) =>
  (operation === MutationOperation.Submit
    ? services.mutations.latest(stored.intent.intentId, MutationOperation.Cancel)
    : Effect.succeed(undefined)
  ).pipe(
    Effect.flatMap((cancellation) => liftDecision(validateRecovery(stored.intent, event, cancellation))),
    Effect.andThen(Clock.currentTimeMillis),
    Effect.flatMap((currentMillis) =>
      liftDecision(ensureRecoveryDelay(operation, event, currentMillis)).pipe(
        Effect.flatMap((ready) =>
          markInterruptedStart(services.mutations, ready, utcInstantFromEpochMillis(currentMillis)),
        ),
      ),
    ),
    Effect.flatMap((interrupted) => recoverAtBroker(services, stored, operation, interrupted)),
  )

const runRecovery = (services: RecoveryServices, intentId: string, operation: MutationOperation) =>
  readIntent(operation, intentId).pipe(
    Effect.flatMap((stored) =>
      services.mutations.latest(intentId, operation).pipe(
        Effect.flatMap((latest) => liftDecision(selectRecovery(operation, stored.intent, latest))),
        Effect.flatMap((selection) =>
          Match.value(selection).pipe(
            Match.tagsExhaustive({
              RecoveryComplete: ({ event }) => Effect.succeed(event),
              RecoveryRequired: ({ event }) => continueRecovery(services, stored, operation, event),
            }),
          ),
        ),
      ),
    ),
  )

export const recover = (intentId: string, operation: MutationOperation) =>
  Effect.all({
    mutations: MutationStore,
    broker: BrokerRead,
  }).pipe(Effect.flatMap((services) => runRecovery(services, intentId, operation)))
