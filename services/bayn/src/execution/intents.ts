import { Buffer } from 'node:buffer'

import { PgClient } from '@effect/sql-pg'
import { Context, Data, Effect, Layer, Option, Schema } from 'effect'
import type { Fragment } from 'effect/unstable/sql/Statement'

import { canonicalHashV1 } from '../hash'
import {
  Authority,
  decodeIntent,
  decodeReferenceIntent,
  decodeRiskDecision,
  IntentSchema,
  IntentState,
  OrderSide,
  OrderType,
  PositiveMicrosSchema,
  RiskDecisionSchema,
  RiskOutcome,
  TerminalOutcome,
  TimeInForce,
  type Intent,
  type ReferenceIntent,
  type RiskDecision,
} from '../paper'
import type { State } from '../risk'
import {
  Sha256Schema as Sha256,
  StrictNonEmptyStringSchema as NonEmptyString,
  SymbolSchema as SymbolName,
  UtcInstantSchema as UtcInstant,
  strictParseOptions,
} from '../schemas'
import { WriterFence, WriterFenceError } from './writer-fence'

export const IntentPlanSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.paper-intent-plan.v1'),
  strategyName: NonEmptyString,
  cycleId: Sha256,
  decisionHash: Sha256,
  policyHash: Sha256,
  accountId: NonEmptyString,
  symbol: SymbolName,
  side: Schema.Enum(OrderSide),
  orderType: Schema.Enum(OrderType),
  timeInForce: Schema.Enum(TimeInForce),
  quantityMicros: PositiveMicrosSchema,
  notionalLimitMicros: PositiveMicrosSchema,
  createdAt: UtcInstant,
})
export type IntentPlan = typeof IntentPlanSchema.Type

const decodePlan = Schema.decodeUnknownEffect(IntentPlanSchema, strictParseOptions)
const intentEquivalent = Schema.toEquivalence(IntentSchema)
const decisionEquivalent = Schema.toEquivalence(RiskDecisionSchema)

const referenceIdentityMaterial = (input: IntentPlan) => ({
  schemaVersion: 'bayn.paper-intent-identity.v1',
  strategyName: input.strategyName,
  cycleId: input.cycleId,
  decisionHash: input.decisionHash,
  accountId: input.accountId,
  symbol: input.symbol,
  side: input.side,
  orderType: input.orderType,
  timeInForce: input.timeInForce,
  quantityMicros: input.quantityMicros,
  notionalLimitMicros: input.notionalLimitMicros,
})

const paperIdentityMaterial = (input: IntentPlan, authorityGenerationHash: string) => ({
  schemaVersion: 'bayn.paper-intent-identity.v2',
  authorityGenerationHash,
  strategyName: input.strategyName,
  cycleId: input.cycleId,
  decisionHash: input.decisionHash,
  accountId: input.accountId,
  symbol: input.symbol,
  side: input.side,
  orderType: input.orderType,
  timeInForce: input.timeInForce,
  quantityMicros: input.quantityMicros,
  notionalLimitMicros: input.notionalLimitMicros,
})

export const intentIdForPlan = (input: IntentPlan): string => canonicalHashV1(referenceIdentityMaterial(input))

const clientOrderId = (intentId: string): string => `b1_${Buffer.from(intentId, 'hex').toString('base64url')}`

const makeReferenceIntent = (decoded: IntentPlan): Effect.Effect<ReferenceIntent, Schema.SchemaError> => {
  const intentId = intentIdForPlan(decoded)
  return decodeReferenceIntent({
    schemaVersion: 'bayn.paper-intent.v2',
    intentId,
    strategyName: decoded.strategyName,
    cycleId: decoded.cycleId,
    decisionHash: decoded.decisionHash,
    policyHash: decoded.policyHash,
    accountId: decoded.accountId,
    clientOrderId: clientOrderId(intentId),
    symbol: decoded.symbol,
    side: decoded.side,
    orderType: decoded.orderType,
    timeInForce: decoded.timeInForce,
    quantityMicros: decoded.quantityMicros,
    notionalLimitMicros: decoded.notionalLimitMicros,
    state: IntentState.Planned,
    createdAt: decoded.createdAt,
  })
}

const makePaperIntent = (
  decoded: IntentPlan,
  authorityGenerationHash: string,
): Effect.Effect<Intent, Schema.SchemaError> => {
  const intentId = canonicalHashV1(paperIdentityMaterial(decoded, authorityGenerationHash))
  return decodeIntent({
    schemaVersion: 'bayn.paper-intent.v3',
    authorityGenerationHash,
    intentId,
    strategyName: decoded.strategyName,
    cycleId: decoded.cycleId,
    decisionHash: decoded.decisionHash,
    policyHash: decoded.policyHash,
    accountId: decoded.accountId,
    clientOrderId: clientOrderId(intentId),
    symbol: decoded.symbol,
    side: decoded.side,
    orderType: decoded.orderType,
    timeInForce: decoded.timeInForce,
    quantityMicros: decoded.quantityMicros,
    notionalLimitMicros: decoded.notionalLimitMicros,
    state: IntentState.Planned,
    createdAt: decoded.createdAt,
  })
}

export const plan = (input: unknown) => decodePlan(input).pipe(Effect.flatMap(makeReferenceIntent))

export class PaperIntentBindingError extends Data.TaggedError('PaperIntentBindingError')<{
  readonly message: string
}> {}

export const planPaperIntent = (input: unknown, state: Pick<State, 'authority'>) =>
  Effect.gen(function* () {
    const decoded = yield* decodePlan(input)
    if (state.authority.maximum !== Authority.Paper) {
      return yield* Effect.fail(
        new PaperIntentBindingError({
          message: 'a durable PAPER intent requires a PAPER authority generation from risk state',
        }),
      )
    }
    return yield* makePaperIntent(decoded, state.authority.generationHash)
  })

export class IntentStoreError extends Data.TaggedError('IntentStoreError')<{
  readonly failure: 'conflict' | 'decode' | 'invariant' | 'query'
  readonly operation: 'commit' | 'mark-io-started' | 'read'
  readonly message: string
  readonly cause?: unknown
}> {}

export interface StoredIntent {
  readonly intent: Intent
  readonly decision?: RiskDecision
  readonly stateVersion: number
  readonly updatedAt: string
}

export interface IntentReceipt {
  readonly record: StoredIntent
  readonly deduplicated: boolean
}

export interface IntentStoreService {
  readonly commit: (
    intent: Intent,
    decision: RiskDecision,
  ) => Effect.Effect<IntentReceipt, IntentStoreError | WriterFenceError>
  readonly markIoStarted: (
    intentId: string,
    updatedAt: string,
  ) => Effect.Effect<IntentReceipt, IntentStoreError | WriterFenceError>
  readonly read: (intentId: string) => Effect.Effect<Option.Option<StoredIntent>, IntentStoreError>
}

export class IntentStore extends Context.Service<IntentStore, IntentStoreService>()('bayn/IntentStore') {}

const intentRowFields = {
  schema_version: Schema.Literal('bayn.paper-intent.v3'),
  intent_id: Sha256,
  risk_decision_id: Schema.NullOr(Sha256),
  authority_generation_hash: Sha256,
  strategy_name: NonEmptyString,
  cycle_id: Sha256,
  decision_hash: Sha256,
  policy_hash: Sha256,
  account_id: NonEmptyString,
  client_order_id: NonEmptyString,
  symbol: SymbolName,
  side: Schema.Enum(OrderSide),
  order_type: Schema.Enum(OrderType),
  time_in_force: Schema.Enum(TimeInForce),
  quantity_micros: PositiveMicrosSchema,
  notional_limit_micros: PositiveMicrosSchema,
  state: Schema.Enum(IntentState),
  terminal_outcome: Schema.NullOr(Schema.Enum(TerminalOutcome)),
  state_version: Schema.Int.check(Schema.isGreaterThan(0)),
  created_at: UtcInstant,
  updated_at: UtcInstant,
} as const

const WithoutDecisionRow = Schema.Struct({
  ...intentRowFields,
  decision_id: Schema.Null,
  input_hash: Schema.Null,
  decision_policy_hash: Schema.Null,
  outcome: Schema.Null,
  reason_codes: Schema.Null,
  decided_at: Schema.Null,
  expires_at: Schema.Null,
})
const WithDecisionRow = Schema.Struct({
  ...intentRowFields,
  decision_id: Sha256,
  input_hash: Sha256,
  decision_policy_hash: Sha256,
  outcome: Schema.Enum(RiskOutcome),
  reason_codes: Schema.Array(NonEmptyString).check(Schema.isUnique()),
  decided_at: UtcInstant,
  expires_at: UtcInstant,
})
const StoredRow = Schema.Union([WithoutDecisionRow, WithDecisionRow])
type StoredRow = typeof StoredRow.Type
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(StoredRow), strictParseOptions)
const decodeIntentId = Schema.decodeUnknownEffect(Sha256)
const decodeUpdatedAt = Schema.decodeUnknownEffect(UtcInstant)

const selectRows = (sql: PgClient.PgClient, predicate: Fragment) => sql`
  SELECT
    intent.schema_version,
    intent.intent_id,
    intent.risk_decision_id,
    intent.authority_generation_hash,
    intent.strategy_name,
    intent.cycle_id,
    intent.decision_hash,
    intent.policy_hash,
    intent.account_id,
    intent.client_order_id,
    intent.symbol,
    intent.side,
    intent.order_type,
    intent.time_in_force,
    intent.quantity_micros::text,
    intent.notional_limit_micros::text,
    intent.state,
    intent.terminal_outcome,
    intent.state_version::integer,
    to_char(intent.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
    to_char(intent.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at,
    decision.decision_id,
    decision.input_hash,
    decision.policy_hash AS decision_policy_hash,
    decision.outcome,
    decision.reason_codes,
    to_char(decision.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS decided_at,
    to_char(decision.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at
  FROM intents AS intent
  LEFT JOIN risk_decisions AS decision ON decision.intent_id = intent.intent_id
  WHERE ${predicate}
`

const toRecord = (row: StoredRow) =>
  Effect.gen(function* () {
    const intent = yield* decodeIntent({
      schemaVersion: row.schema_version,
      intentId: row.intent_id,
      ...(row.risk_decision_id === null ? {} : { riskDecisionId: row.risk_decision_id }),
      authorityGenerationHash: row.authority_generation_hash,
      strategyName: row.strategy_name,
      cycleId: row.cycle_id,
      decisionHash: row.decision_hash,
      policyHash: row.policy_hash,
      accountId: row.account_id,
      clientOrderId: row.client_order_id,
      symbol: row.symbol,
      side: row.side,
      orderType: row.order_type,
      timeInForce: row.time_in_force,
      quantityMicros: row.quantity_micros,
      notionalLimitMicros: row.notional_limit_micros,
      state: row.state,
      ...(row.terminal_outcome === null ? {} : { terminalOutcome: row.terminal_outcome }),
      createdAt: row.created_at,
    })
    const decision =
      row.decision_id === null
        ? undefined
        : yield* decodeRiskDecision({
            schemaVersion: 'bayn.paper-risk-decision.v1',
            decisionId: row.decision_id,
            inputHash: row.input_hash,
            intentId: row.intent_id,
            policyHash: row.decision_policy_hash,
            outcome: row.outcome,
            reasonCodes: row.reason_codes,
            decidedAt: row.decided_at,
            expiresAt: row.expires_at,
          })
    return { intent, decision, stateVersion: row.state_version, updatedAt: row.updated_at } satisfies StoredIntent
  })

const immutableIntentHash = (intent: Intent): string =>
  canonicalHashV1({
    schemaVersion: intent.schemaVersion,
    intentId: intent.intentId,
    authorityGenerationHash: intent.authorityGenerationHash,
    strategyName: intent.strategyName,
    cycleId: intent.cycleId,
    decisionHash: intent.decisionHash,
    policyHash: intent.policyHash,
    accountId: intent.accountId,
    clientOrderId: intent.clientOrderId,
    symbol: intent.symbol,
    side: intent.side,
    orderType: intent.orderType,
    timeInForce: intent.timeInForce,
    quantityMicros: intent.quantityMicros,
    notionalLimitMicros: intent.notionalLimitMicros,
    createdAt: intent.createdAt,
  })

const storeError = (
  failure: IntentStoreError['failure'],
  operation: IntentStoreError['operation'],
  message: string,
  cause?: unknown,
) => new IntentStoreError({ failure, operation, message, cause })

const makeStore = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const fence = yield* WriterFence

  const run = <A, E, R>(
    operation: IntentStoreError['operation'],
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, IntentStoreError | WriterFenceError, R> =>
    effect.pipe(
      Effect.mapError((cause) =>
        cause instanceof WriterFenceError || cause instanceof IntentStoreError
          ? cause
          : storeError('query', operation, `intent ${operation} failed`, cause),
      ),
    )

  const decodeStored = (operation: IntentStoreError['operation'], rows: unknown) =>
    decodeRows(rows).pipe(
      Effect.mapError((cause) => storeError('decode', operation, 'stored intent rows failed schema decoding', cause)),
      Effect.flatMap((decoded) =>
        Effect.forEach(decoded, (row) =>
          toRecord(row).pipe(
            Effect.mapError((cause) =>
              storeError('decode', operation, 'stored intent payload failed schema decoding', cause),
            ),
          ),
        ),
      ),
    )

  const readById = (operation: IntentStoreError['operation'], intentId: string) =>
    Effect.gen(function* () {
      const decodedId = yield* decodeIntentId(intentId).pipe(
        Effect.mapError((cause) => storeError('decode', operation, 'invalid intent ID', cause)),
      )
      const rows = yield* selectRows(sql, sql`intent.intent_id = ${decodedId}`)
      const records = yield* decodeStored(operation, rows)
      if (records.length > 1) {
        return yield* Effect.fail(storeError('invariant', operation, 'intent ID returned multiple records'))
      }
      return Option.fromNullishOr(records[0])
    })

  const withFence = fence.transaction

  const commit = (inputIntent: Intent, inputDecision: RiskDecision) =>
    run(
      'commit',
      Effect.gen(function* () {
        const expectedIntent = yield* makePaperIntent(
          {
            schemaVersion: 'bayn.paper-intent-plan.v1',
            strategyName: inputIntent.strategyName,
            cycleId: inputIntent.cycleId,
            decisionHash: inputIntent.decisionHash,
            policyHash: inputIntent.policyHash,
            accountId: inputIntent.accountId,
            symbol: inputIntent.symbol,
            side: inputIntent.side,
            orderType: inputIntent.orderType,
            timeInForce: inputIntent.timeInForce,
            quantityMicros: inputIntent.quantityMicros,
            notionalLimitMicros: inputIntent.notionalLimitMicros,
            createdAt: inputIntent.createdAt,
          },
          inputIntent.authorityGenerationHash,
        ).pipe(Effect.mapError((cause) => storeError('decode', 'commit', 'invalid planned intent', cause)))
        if (!intentEquivalent(inputIntent, expectedIntent)) {
          return yield* Effect.fail(
            storeError('invariant', 'commit', 'planned intent does not match its deterministic identity'),
          )
        }
        const decision = yield* decodeRiskDecision(inputDecision).pipe(
          Effect.mapError((cause) => storeError('decode', 'commit', 'invalid risk decision', cause)),
        )
        const { decisionId, ...decisionMaterial } = decision
        if (decisionId !== canonicalHashV1(decisionMaterial)) {
          return yield* Effect.fail(
            storeError('invariant', 'commit', 'risk decision does not match its deterministic identity'),
          )
        }
        if (decision.intentId !== inputIntent.intentId || decision.policyHash !== inputIntent.policyHash) {
          return yield* Effect.fail(
            storeError('invariant', 'commit', 'risk decision does not match the intent and policy'),
          )
        }

        return yield* withFence(
          Effect.gen(function* () {
            const readConflicts = () =>
              selectRows(
                sql,
                sql`
                intent.intent_id = ${inputIntent.intentId}
                OR (intent.account_id = ${inputIntent.accountId} AND intent.client_order_id = ${inputIntent.clientOrderId})
                OR (
                  intent.account_id = ${inputIntent.accountId}
                  AND intent.strategy_name = ${inputIntent.strategyName}
                  AND intent.cycle_id = ${inputIntent.cycleId}
                  AND intent.decision_hash = ${inputIntent.decisionHash}
                  AND intent.symbol = ${inputIntent.symbol}
                )
              `,
              ).pipe(Effect.flatMap((rows) => decodeStored('commit', rows)))

            let conflictRows = yield* readConflicts()
            if (conflictRows.length > 1) {
              return yield* Effect.fail(
                storeError('conflict', 'commit', 'intent uniqueness boundary resolved to multiple records'),
              )
            }
            const preexisting = conflictRows[0]
            if (preexisting !== undefined) {
              if (immutableIntentHash(preexisting.intent) !== immutableIntentHash(inputIntent)) {
                return yield* Effect.fail(
                  storeError('conflict', 'commit', 'deterministic intent identity was reused with different content'),
                )
              }
              if (preexisting.decision !== undefined) {
                const stateMatchesDecision =
                  decision.outcome === RiskOutcome.Approved
                    ? preexisting.intent.state !== IntentState.Planned
                    : preexisting.intent.state === IntentState.Terminal &&
                      preexisting.intent.terminalOutcome === TerminalOutcome.Blocked
                if (
                  !decisionEquivalent(preexisting.decision, decision) ||
                  preexisting.intent.riskDecisionId !== decision.decisionId ||
                  !stateMatchesDecision
                ) {
                  return yield* Effect.fail(
                    storeError('conflict', 'commit', 'stored intent decision diverges from the requested decision'),
                  )
                }
                return { record: preexisting, deduplicated: true } satisfies IntentReceipt
              }
              if (preexisting.intent.state !== IntentState.Planned || preexisting.intent.riskDecisionId !== undefined) {
                return yield* Effect.fail(storeError('invariant', 'commit', 'intent without a decision is not PLANNED'))
              }
            }

            const authorityRows = yield* sql<{
              generation_account_id: string | null
              generation_hash: string
              generation_maximum: string | null
              generation_risk_policy_hash: string | null
              generation_strategy_name: string | null
              maximum: string
            }>`
              SELECT
                authority.maximum,
                authority.generation_hash,
                generation.maximum AS generation_maximum,
                generation.account_id AS generation_account_id,
                generation.risk_policy_hash AS generation_risk_policy_hash,
                generation.strategy_name AS generation_strategy_name
              FROM authority_state AS authority
              LEFT JOIN authority_generations AS generation
                ON generation.generation_hash = authority.generation_hash
              WHERE authority.singleton
              FOR UPDATE OF authority
            `
            const authority = authorityRows[0]
            if (
              authority === undefined ||
              authority.maximum !== Authority.Paper ||
              authority.generation_hash !== inputIntent.authorityGenerationHash ||
              authority.generation_maximum !== Authority.Paper ||
              authority.generation_account_id !== inputIntent.accountId ||
              authority.generation_risk_policy_hash !== inputIntent.policyHash ||
              authority.generation_strategy_name !== inputIntent.strategyName
            ) {
              return yield* Effect.fail(
                storeError(
                  'invariant',
                  'commit',
                  'PAPER intent does not match the current immutable authority-generation bindings',
                ),
              )
            }

            if (preexisting === undefined) {
              yield* sql`
                INSERT INTO intents (
                  intent_id,
                  schema_version,
                  authority_generation_hash,
                  strategy_name,
                  cycle_id,
                  decision_hash,
                  policy_hash,
                  account_id,
                  client_order_id,
                  symbol,
                  side,
                  order_type,
                  time_in_force,
                  quantity_micros,
                  notional_limit_micros,
                  state,
                  created_at,
                  updated_at
                ) VALUES (
                  ${inputIntent.intentId},
                  ${inputIntent.schemaVersion},
                  ${inputIntent.authorityGenerationHash},
                  ${inputIntent.strategyName},
                  ${inputIntent.cycleId},
                  ${inputIntent.decisionHash},
                  ${inputIntent.policyHash},
                  ${inputIntent.accountId},
                  ${inputIntent.clientOrderId},
                  ${inputIntent.symbol},
                  ${inputIntent.side},
                  ${inputIntent.orderType},
                  ${inputIntent.timeInForce},
                  ${inputIntent.quantityMicros},
                  ${inputIntent.notionalLimitMicros},
                  ${inputIntent.state},
                  ${inputIntent.createdAt},
                  ${inputIntent.createdAt}
                )
                ON CONFLICT DO NOTHING
              `
              conflictRows = yield* readConflicts()
            }
            if (conflictRows.length !== 1) {
              return yield* Effect.fail(
                storeError('conflict', 'commit', 'intent uniqueness boundary did not resolve to one record'),
              )
            }
            const existing = conflictRows[0]
            if (immutableIntentHash(existing.intent) !== immutableIntentHash(inputIntent)) {
              return yield* Effect.fail(
                storeError('conflict', 'commit', 'deterministic intent identity was reused with different content'),
              )
            }
            if (existing.decision !== undefined) {
              const stateMatchesDecision =
                decision.outcome === RiskOutcome.Approved
                  ? existing.intent.state !== IntentState.Planned
                  : existing.intent.state === IntentState.Terminal &&
                    existing.intent.terminalOutcome === TerminalOutcome.Blocked
              if (
                !decisionEquivalent(existing.decision, decision) ||
                existing.intent.riskDecisionId !== decision.decisionId ||
                !stateMatchesDecision
              ) {
                return yield* Effect.fail(
                  storeError('conflict', 'commit', 'stored intent decision diverges from the requested decision'),
                )
              }
              return { record: existing, deduplicated: true } satisfies IntentReceipt
            }
            if (existing.intent.state !== IntentState.Planned || existing.intent.riskDecisionId !== undefined) {
              return yield* Effect.fail(storeError('invariant', 'commit', 'intent without a decision is not PLANNED'))
            }

            const insertedDecision = yield* sql<{ decision_id: string }>`
              INSERT INTO risk_decisions (
                decision_id,
                schema_version,
                input_hash,
                intent_id,
                policy_hash,
                outcome,
                reason_codes,
                decided_at,
                expires_at
              ) VALUES (
                ${decision.decisionId},
                ${decision.schemaVersion},
                ${decision.inputHash},
                ${decision.intentId},
                ${decision.policyHash},
                ${decision.outcome},
                ${decision.reasonCodes},
                ${decision.decidedAt},
                ${decision.expiresAt}
              )
              ON CONFLICT DO NOTHING
              RETURNING decision_id
            `
            if (insertedDecision.length !== 1) {
              return yield* Effect.fail(
                storeError('conflict', 'commit', 'risk decision identity was already used by different content'),
              )
            }

            const approved = decision.outcome === RiskOutcome.Approved
            const transitioned = yield* sql<{ intent_id: string }>`
              UPDATE intents
              SET
                risk_decision_id = ${decision.decisionId},
                state = ${approved ? IntentState.Approved : IntentState.Terminal},
                terminal_outcome = ${approved ? null : TerminalOutcome.Blocked},
                state_version = state_version + 1,
                updated_at = ${decision.decidedAt}
              WHERE intent_id = ${inputIntent.intentId} AND state = ${IntentState.Planned}
              RETURNING intent_id
            `
            if (transitioned.length !== 1) {
              return yield* Effect.fail(storeError('conflict', 'commit', 'planned intent transition lost its race'))
            }

            const stored = yield* readById('commit', inputIntent.intentId)
            if (Option.isNone(stored)) {
              return yield* Effect.fail(storeError('invariant', 'commit', 'committed intent cannot be read back'))
            }
            return { record: stored.value, deduplicated: false } satisfies IntentReceipt
          }),
        )
      }),
    )

  const markIoStarted = (intentId: string, updatedAt: string) =>
    run(
      'mark-io-started',
      Effect.gen(function* () {
        const decodedId = yield* decodeIntentId(intentId).pipe(
          Effect.mapError((cause) => storeError('decode', 'mark-io-started', 'invalid intent ID', cause)),
        )
        const decodedTime = yield* decodeUpdatedAt(updatedAt).pipe(
          Effect.mapError((cause) => storeError('decode', 'mark-io-started', 'invalid transition time', cause)),
        )
        return yield* withFence(
          Effect.gen(function* () {
            const current = yield* readById('mark-io-started', decodedId)
            if (Option.isNone(current)) {
              return yield* Effect.fail(storeError('invariant', 'mark-io-started', 'intent does not exist'))
            }
            if (current.value.intent.state === IntentState.IoStarted) {
              return { record: current.value, deduplicated: true } satisfies IntentReceipt
            }
            if (
              current.value.intent.state !== IntentState.Approved ||
              current.value.decision?.outcome !== RiskOutcome.Approved
            ) {
              return yield* Effect.fail(
                storeError('invariant', 'mark-io-started', 'only an approved intent may enter IO_STARTED'),
              )
            }
            const transitioned = yield* sql<{ intent_id: string }>`
              UPDATE intents
              SET state = ${IntentState.IoStarted}, state_version = state_version + 1, updated_at = ${decodedTime}
              WHERE intent_id = ${decodedId} AND state = ${IntentState.Approved}
              RETURNING intent_id
            `
            if (transitioned.length !== 1) {
              return yield* Effect.fail(
                storeError('conflict', 'mark-io-started', 'approved intent transition lost its race'),
              )
            }
            const stored = yield* readById('mark-io-started', decodedId)
            if (Option.isNone(stored)) {
              return yield* Effect.fail(
                storeError('invariant', 'mark-io-started', 'IO_STARTED intent cannot be read back'),
              )
            }
            return { record: stored.value, deduplicated: false } satisfies IntentReceipt
          }),
        )
      }),
    )

  return {
    commit,
    markIoStarted,
    read: (intentId) =>
      readById('read', intentId).pipe(
        Effect.mapError((cause) =>
          cause instanceof IntentStoreError ? cause : storeError('query', 'read', 'intent read failed', cause),
        ),
      ),
  } satisfies IntentStoreService
})

export const IntentStoreLive = Layer.effect(IntentStore, makeStore)
