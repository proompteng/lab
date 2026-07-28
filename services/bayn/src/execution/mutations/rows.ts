import { Result, Schema } from 'effect'

import { MutationOperation } from '../../broker/alpaca-mutations'
import { IntentState, TerminalOutcome } from '../contracts'
import { Authority, KillState } from '../legacy-paper-codecs'
import {
  Sha256Schema as Sha256,
  StrictNonEmptyStringSchema as NonEmptyString,
  UtcInstantSchema as UtcInstant,
  strictParseOptions,
} from '../../schemas'
import { startStoreOperationFor, storeError } from './decisions'
import {
  ConsistencyDelay,
  HttpStatus,
  MutationEventType,
  Sequence,
  type MutationAuthoritySnapshot,
  type MutationEvent,
  type MutationIntentSnapshot,
  type MutationReplayIntentSnapshot,
  type MutationStoreError,
  type OutcomeStoreOperation,
} from './model'

const StoredEventRows = Schema.Array(
  Schema.Struct({
    schema_version: Schema.Literal('bayn.paper-mutation-event.v1'),
    event_id: Sha256,
    mutation_id: Sha256,
    intent_id: Sha256,
    sequence: Sequence,
    operation: Schema.Enum(MutationOperation),
    event_type: Schema.Enum(MutationEventType),
    request_hash: Sha256,
    consistency_delay_ms: ConsistencyDelay,
    broker_order_id: Schema.NullOr(NonEmptyString),
    request_id: Schema.NullOr(NonEmptyString),
    response_status: Schema.NullOr(HttpStatus),
    response_content_hash: Schema.NullOr(Sha256),
    occurred_at: UtcInstant,
  }),
)

const AuthorityRows = Schema.Array(
  Schema.Struct({
    effective: Schema.Enum(Authority),
    generation_hash: Sha256,
    generation_account_id: Schema.NullOr(NonEmptyString),
    generation_maximum: Schema.NullOr(Schema.Enum(Authority)),
    kill_state: Schema.Enum(KillState),
    maximum: Schema.Enum(Authority),
  }),
)

const IntentRows = Schema.Array(
  Schema.Struct({
    account_id: NonEmptyString,
    authority_generation_hash: Sha256,
    generation_account_id: Schema.NullOr(NonEmptyString),
    generation_maximum: Schema.NullOr(Schema.Enum(Authority)),
    generation_risk_policy_hash: Schema.NullOr(Sha256),
    generation_strategy_name: Schema.NullOr(NonEmptyString),
    policy_hash: Sha256,
    state: Schema.Enum(IntentState),
    strategy_name: NonEmptyString,
    updated_at: UtcInstant,
  }),
)

const UnresolvedRows = Schema.Array(Schema.Struct({ unresolved: Schema.Boolean }))
const EventIdRows = Schema.Array(Schema.Struct({ event_id: Sha256 }))
const IntentIdRows = Schema.Array(Schema.Struct({ intent_id: Sha256 }))
const OutcomeIntentRows = Schema.Array(
  Schema.Struct({
    state: Schema.Enum(IntentState),
    terminal_outcome: Schema.NullOr(Schema.Enum(TerminalOutcome)),
  }),
)
const AcknowledgedRows = Schema.Array(Schema.Struct({ acknowledged: Schema.Boolean }))

const decodeStoredEventRows = Schema.decodeUnknownResult(StoredEventRows, strictParseOptions)
const decodeAuthorityRows = Schema.decodeUnknownResult(AuthorityRows, strictParseOptions)
const decodeIntentRows = Schema.decodeUnknownResult(IntentRows, strictParseOptions)
const decodeUnresolvedRows = Schema.decodeUnknownResult(UnresolvedRows, strictParseOptions)
const decodeEventIdRows = Schema.decodeUnknownResult(EventIdRows, strictParseOptions)
const decodeIntentIdRows = Schema.decodeUnknownResult(IntentIdRows, strictParseOptions)
const decodeOutcomeIntentRows = Schema.decodeUnknownResult(OutcomeIntentRows, strictParseOptions)
const decodeAcknowledgedRows = Schema.decodeUnknownResult(AcknowledgedRows, strictParseOptions)
const decodeIntentIdResult = Schema.decodeUnknownResult(Sha256)

const toEvent = (row: (typeof StoredEventRows.Type)[number]): MutationEvent => ({
  schemaVersion: row.schema_version,
  eventId: row.event_id,
  mutationId: row.mutation_id,
  intentId: row.intent_id,
  sequence: row.sequence,
  operation: row.operation,
  eventType: row.event_type,
  requestHash: row.request_hash,
  consistencyDelayMs: row.consistency_delay_ms,
  ...(row.broker_order_id === null ? {} : { brokerOrderId: row.broker_order_id }),
  ...(row.request_id === null ? {} : { requestId: row.request_id }),
  ...(row.response_status === null ? {} : { responseStatus: row.response_status }),
  ...(row.response_content_hash === null ? {} : { responseContentHash: row.response_content_hash }),
  occurredAt: row.occurred_at,
})

export const decodeStoredEvents = (rows: unknown): Result.Result<readonly MutationEvent[], MutationStoreError> =>
  Result.map(
    Result.mapError(decodeStoredEventRows(rows), (cause) =>
      storeError('read', 'decode', 'stored mutation event failed decoding', cause),
    ),
    (decoded) => decoded.map(toEvent),
  )

export const decodeIntentId = (intentId: string): Result.Result<string, MutationStoreError> =>
  Result.mapError(decodeIntentIdResult(intentId), (cause) => storeError('read', 'decode', 'invalid intent ID', cause))

export const decodeAuthoritySnapshot = (
  operation: MutationOperation,
  rows: unknown,
): Result.Result<MutationAuthoritySnapshot | undefined, MutationStoreError> =>
  Result.map(
    Result.mapError(decodeAuthorityRows(rows), (cause) =>
      storeError(startStoreOperationFor(operation), 'decode', 'stored mutation authority failed decoding', cause),
    ),
    (decoded) => {
      const authority = decoded[0]
      return authority === undefined
        ? undefined
        : {
            maximum: authority.maximum,
            effective: authority.effective,
            killState: authority.kill_state,
            generationHash: authority.generation_hash,
            generationMaximum: authority.generation_maximum,
            generationAccountId: authority.generation_account_id,
          }
    },
  )

export const decodeIntentSnapshot = (
  operation: MutationOperation,
  rows: unknown,
): Result.Result<MutationIntentSnapshot | undefined, MutationStoreError> =>
  Result.map(
    Result.mapError(decodeIntentRows(rows), (cause) =>
      storeError(startStoreOperationFor(operation), 'decode', 'stored mutation intent failed decoding', cause),
    ),
    (decoded) => {
      const intent = decoded[0]
      return intent === undefined
        ? undefined
        : {
            accountId: intent.account_id,
            authorityGenerationHash: intent.authority_generation_hash,
            policyHash: intent.policy_hash,
            state: intent.state,
            strategyName: intent.strategy_name,
            updatedAt: intent.updated_at,
            generationAccountId: intent.generation_account_id,
            generationMaximum: intent.generation_maximum,
            generationRiskPolicyHash: intent.generation_risk_policy_hash,
            generationStrategyName: intent.generation_strategy_name,
          }
    },
  )

export const decodeUnresolved = (rows: unknown): Result.Result<boolean | undefined, MutationStoreError> =>
  Result.map(
    Result.mapError(decodeUnresolvedRows(rows), (cause) =>
      storeError('begin-submit', 'decode', 'unresolved mutation result failed decoding', cause),
    ),
    (decoded) => decoded[0]?.unresolved,
  )

export const decodeEventIds = (
  operation: MutationStoreError['operation'],
  rows: unknown,
): Result.Result<readonly string[], MutationStoreError> =>
  Result.map(
    Result.mapError(decodeEventIdRows(rows), (cause) =>
      storeError(operation, 'decode', 'mutation event append result failed decoding', cause),
    ),
    (decoded) => decoded.map((row) => row.event_id),
  )

export const decodeIntentIds = (
  operation: OutcomeStoreOperation | 'begin-submit',
  message: string,
  rows: unknown,
): Result.Result<readonly string[], MutationStoreError> =>
  Result.map(
    Result.mapError(decodeIntentIdRows(rows), (cause) => storeError(operation, 'decode', message, cause)),
    (decoded) => decoded.map((row) => row.intent_id),
  )

export const decodeOutcomeIntentSnapshot = (
  operation: OutcomeStoreOperation,
  rows: unknown,
): Result.Result<MutationReplayIntentSnapshot | undefined, MutationStoreError> =>
  Result.map(
    Result.mapError(decodeOutcomeIntentRows(rows), (cause) =>
      storeError(operation, 'decode', 'stored mutation intent state failed decoding', cause),
    ),
    (decoded) => {
      const intent = decoded[0]
      return intent === undefined
        ? undefined
        : {
            state: intent.state,
            terminalOutcome: intent.terminal_outcome,
          }
    },
  )

export const decodeAcknowledged = (
  operation: OutcomeStoreOperation,
  rows: unknown,
): Result.Result<boolean | undefined, MutationStoreError> =>
  Result.map(
    Result.mapError(decodeAcknowledgedRows(rows), (cause) =>
      storeError(operation, 'decode', 'acknowledged submit recovery result failed decoding', cause),
    ),
    (decoded) => decoded[0]?.acknowledged,
  )
