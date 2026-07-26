import { Buffer } from 'node:buffer'

import { PgClient } from '@effect/sql-pg'
import { Context, Data, Effect, Layer, Option, Result, Schema } from 'effect'
import { isSqlError } from 'effect/unstable/sql/SqlError'
import type { Fragment } from 'effect/unstable/sql/Statement'

import { canonicalHashV1Result, type CanonicalHashFailure } from '../hash'
import {
  Authority,
  IntentSchema,
  IntentState,
  KillState,
  OrderSide,
  OrderType,
  PositiveMicrosSchema,
  ReferenceIntentSchema,
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

const decodePlanResult = Schema.decodeUnknownResult(IntentPlanSchema, strictParseOptions)
const decodeAuthorityGenerationHashResult = Schema.decodeUnknownResult(Sha256, strictParseOptions)
const decodeIntentResult = Schema.decodeUnknownResult(IntentSchema, strictParseOptions)
const decodeRiskDecisionResult = Schema.decodeUnknownResult(RiskDecisionSchema, strictParseOptions)
const decodeIntentIdResult = Schema.decodeUnknownResult(Sha256, strictParseOptions)
const intentEquivalent = Schema.toEquivalence(IntentSchema)
const decisionEquivalent = Schema.toEquivalence(RiskDecisionSchema)

export type IntentCanonicalMaterial =
  | {
      readonly _tag: 'ReferenceIntentIdentity'
      readonly strategyName: string
      readonly cycleId: string
      readonly decisionHash: string
      readonly accountId: string
      readonly symbol: string
    }
  | {
      readonly _tag: 'PaperIntentIdentity'
      readonly authorityGenerationHash: string
      readonly strategyName: string
      readonly cycleId: string
      readonly decisionHash: string
      readonly accountId: string
      readonly symbol: string
    }
  | { readonly _tag: 'ImmutableIntentContent'; readonly intentId: string }
  | { readonly _tag: 'RiskDecisionIdentity'; readonly decisionId: string; readonly intentId: string }

export interface IntentCanonicalizationFailure {
  readonly _tag: 'CanonicalizationFailed'
  readonly material: IntentCanonicalMaterial
  readonly cause: CanonicalHashFailure
}

const canonicalHashResult = (
  material: IntentCanonicalMaterial,
  value: unknown,
): Result.Result<string, IntentCanonicalizationFailure> =>
  Result.mapError(
    canonicalHashV1Result(value),
    (cause): IntentCanonicalizationFailure => ({ _tag: 'CanonicalizationFailed', material, cause }),
  )

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

const referenceIntentIdResult = (input: IntentPlan): Result.Result<string, IntentCanonicalizationFailure> =>
  canonicalHashResult(
    {
      _tag: 'ReferenceIntentIdentity',
      strategyName: input.strategyName,
      cycleId: input.cycleId,
      decisionHash: input.decisionHash,
      accountId: input.accountId,
      symbol: input.symbol,
    },
    referenceIdentityMaterial(input),
  )

const paperIntentIdResult = (
  input: IntentPlan,
  authorityGenerationHash: string,
): Result.Result<string, IntentCanonicalizationFailure> =>
  canonicalHashResult(
    {
      _tag: 'PaperIntentIdentity',
      authorityGenerationHash,
      strategyName: input.strategyName,
      cycleId: input.cycleId,
      decisionHash: input.decisionHash,
      accountId: input.accountId,
      symbol: input.symbol,
    },
    paperIdentityMaterial(input, authorityGenerationHash),
  )

export const intentIdForPlan = referenceIntentIdResult

const clientOrderId = (intentId: string): string => `b1_${Buffer.from(intentId, 'hex').toString('base64url')}`

type IntentConstructionFailure =
  | IntentCanonicalizationFailure
  | {
      readonly _tag: 'ConstructedIntentDecodeFailed'
      readonly intentKind: 'reference' | 'paper'
      readonly cause: unknown
    }

const makeReferenceIntentResult = (decoded: IntentPlan): Result.Result<ReferenceIntent, IntentConstructionFailure> => {
  const intentId = referenceIntentIdResult(decoded)
  if (Result.isFailure(intentId)) return Result.fail(intentId.failure)
  return Result.mapError(
    Schema.decodeUnknownResult(
      ReferenceIntentSchema,
      strictParseOptions,
    )({
      schemaVersion: 'bayn.paper-intent.v2',
      intentId: intentId.success,
      strategyName: decoded.strategyName,
      cycleId: decoded.cycleId,
      decisionHash: decoded.decisionHash,
      policyHash: decoded.policyHash,
      accountId: decoded.accountId,
      clientOrderId: clientOrderId(intentId.success),
      symbol: decoded.symbol,
      side: decoded.side,
      orderType: decoded.orderType,
      timeInForce: decoded.timeInForce,
      quantityMicros: decoded.quantityMicros,
      notionalLimitMicros: decoded.notionalLimitMicros,
      state: IntentState.Planned,
      createdAt: decoded.createdAt,
    }),
    (cause): IntentConstructionFailure => ({ _tag: 'ConstructedIntentDecodeFailed', intentKind: 'reference', cause }),
  )
}

const makePaperIntentResult = (
  decoded: IntentPlan,
  authorityGenerationHash: string,
): Result.Result<Intent, IntentConstructionFailure> => {
  const intentId = paperIntentIdResult(decoded, authorityGenerationHash)
  if (Result.isFailure(intentId)) return Result.fail(intentId.failure)
  return Result.mapError(
    decodeIntentResult({
      schemaVersion: 'bayn.paper-intent.v3',
      authorityGenerationHash,
      intentId: intentId.success,
      strategyName: decoded.strategyName,
      cycleId: decoded.cycleId,
      decisionHash: decoded.decisionHash,
      policyHash: decoded.policyHash,
      accountId: decoded.accountId,
      clientOrderId: clientOrderId(intentId.success),
      symbol: decoded.symbol,
      side: decoded.side,
      orderType: decoded.orderType,
      timeInForce: decoded.timeInForce,
      quantityMicros: decoded.quantityMicros,
      notionalLimitMicros: decoded.notionalLimitMicros,
      state: IntentState.Planned,
      createdAt: decoded.createdAt,
    }),
    (cause): IntentConstructionFailure => ({ _tag: 'ConstructedIntentDecodeFailed', intentKind: 'paper', cause }),
  )
}

export type IntentPlanningFailure =
  | { readonly _tag: 'IntentPlanDecodeFailed'; readonly cause: unknown }
  | { readonly _tag: 'AuthorityGenerationHashDecodeFailed'; readonly cause: unknown }
  | IntentConstructionFailure

const decodePlanForPlanning = (input: unknown): Result.Result<IntentPlan, IntentPlanningFailure> =>
  Result.mapError(
    decodePlanResult(input),
    (cause): IntentPlanningFailure => ({ _tag: 'IntentPlanDecodeFailed', cause }),
  )

export const plan = (input: unknown): Effect.Effect<ReferenceIntent, IntentPlanningFailure> => {
  const decoded = decodePlanForPlanning(input)
  return Effect.fromResult(Result.flatMap(decoded, makeReferenceIntentResult))
}

export const paperIntentIdForPlan = (
  input: unknown,
  authorityGenerationHash: string,
): Effect.Effect<string, IntentPlanningFailure> => {
  const decoded = decodePlanForPlanning(input)
  const generation = Result.mapError(
    decodeAuthorityGenerationHashResult(authorityGenerationHash),
    (cause): IntentPlanningFailure => ({ _tag: 'AuthorityGenerationHashDecodeFailed', cause }),
  )
  return Effect.fromResult(
    Result.flatMap(decoded, (intentPlan) =>
      Result.flatMap(generation, (generationHash) => paperIntentIdResult(intentPlan, generationHash)),
    ),
  )
}

export class PaperIntentBindingError extends Data.TaggedError('PaperIntentBindingError')<{
  readonly message: string
}> {}

export const planPaperIntent = (
  input: unknown,
  state: Pick<State, 'authority'>,
): Effect.Effect<Intent, IntentPlanningFailure | PaperIntentBindingError> => {
  if (state.authority.maximum !== Authority.Paper) {
    return Effect.fail(
      new PaperIntentBindingError({
        message: 'a durable PAPER intent requires a PAPER authority generation from risk state',
      }),
    )
  }
  return Effect.fromResult(
    Result.flatMap(decodePlanForPlanning(input), (decoded) =>
      makePaperIntentResult(decoded, state.authority.generationHash),
    ),
  )
}

export class IntentStoreError extends Data.TaggedError('IntentStoreError')<{
  readonly failure: 'conflict' | 'decode' | 'invariant' | 'query'
  readonly operation: 'commit' | 'read'
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
const decodeStoredRowsResult = Schema.decodeUnknownResult(Schema.Array(StoredRow), strictParseOptions)

const AuthorityBindingRow = Schema.Struct({
  maximum: Schema.Enum(Authority),
  effective: Schema.Enum(Authority),
  kill_state: Schema.Enum(KillState),
  generation_hash: Sha256,
  generation_maximum: Schema.NullOr(Schema.Enum(Authority)),
  generation_account_id: Schema.NullOr(NonEmptyString),
  generation_risk_policy_hash: Schema.NullOr(Sha256),
  generation_strategy_name: Schema.NullOr(NonEmptyString),
})
export type AuthorityBindingRow = typeof AuthorityBindingRow.Type
const decodeAuthorityBindingRowsResult = Schema.decodeUnknownResult(
  Schema.Array(AuthorityBindingRow),
  strictParseOptions,
)

const IntentReturningRow = Schema.Struct({ intent_id: Sha256 })
const DecisionReturningRow = Schema.Struct({ decision_id: Sha256 })
const decodeIntentReturningRowsResult = Schema.decodeUnknownResult(Schema.Array(IntentReturningRow), strictParseOptions)
const decodeDecisionReturningRowsResult = Schema.decodeUnknownResult(
  Schema.Array(DecisionReturningRow),
  strictParseOptions,
)

export type StoredRowsFailure =
  | { readonly _tag: 'StoredRowsDecodeFailed'; readonly cause: unknown }
  | { readonly _tag: 'StoredIntentDecodeFailed'; readonly intentId: string; readonly cause: unknown }
  | { readonly _tag: 'StoredRiskDecisionDecodeFailed'; readonly intentId: string; readonly cause: unknown }

const storedRowToRecord = (row: StoredRow): Result.Result<StoredIntent, StoredRowsFailure> => {
  const intent = decodeIntentResult({
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
  if (Result.isFailure(intent)) {
    return Result.fail({ _tag: 'StoredIntentDecodeFailed', intentId: row.intent_id, cause: intent.failure })
  }
  if (row.decision_id === null) {
    return Result.succeed({
      intent: intent.success,
      stateVersion: row.state_version,
      updatedAt: row.updated_at,
    })
  }
  const decision = decodeRiskDecisionResult({
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
  if (Result.isFailure(decision)) {
    return Result.fail({ _tag: 'StoredRiskDecisionDecodeFailed', intentId: row.intent_id, cause: decision.failure })
  }
  return Result.succeed({
    intent: intent.success,
    decision: decision.success,
    stateVersion: row.state_version,
    updatedAt: row.updated_at,
  })
}

export const decodeStoredIntentRows = (rows: unknown): Result.Result<readonly StoredIntent[], StoredRowsFailure> => {
  const decoded = decodeStoredRowsResult(rows)
  if (Result.isFailure(decoded)) return Result.fail({ _tag: 'StoredRowsDecodeFailed', cause: decoded.failure })
  return Result.all(decoded.success.map(storedRowToRecord))
}

export type CommitMaterialFailure =
  | { readonly _tag: 'IntentDecodeFailed'; readonly cause: unknown }
  | { readonly _tag: 'RiskDecisionDecodeFailed'; readonly cause: unknown }
  | IntentConstructionFailure
  | { readonly _tag: 'IntentIdentityMismatch'; readonly intentId: string }
  | IntentCanonicalizationFailure
  | { readonly _tag: 'RiskDecisionIdentityMismatch'; readonly decisionId: string; readonly expectedDecisionId: string }
  | {
      readonly _tag: 'RiskDecisionBindingMismatch'
      readonly intentId: string
      readonly decisionIntentId: string
      readonly policyHash: string
      readonly decisionPolicyHash: string
    }

export interface PreparedCommit {
  readonly _tag: 'PreparedCommit'
  readonly intent: Intent
  readonly decision: RiskDecision
}

const planFromIntent = (intent: Intent): IntentPlan => ({
  schemaVersion: 'bayn.paper-intent-plan.v1',
  strategyName: intent.strategyName,
  cycleId: intent.cycleId,
  decisionHash: intent.decisionHash,
  policyHash: intent.policyHash,
  accountId: intent.accountId,
  symbol: intent.symbol,
  side: intent.side,
  orderType: intent.orderType,
  timeInForce: intent.timeInForce,
  quantityMicros: intent.quantityMicros,
  notionalLimitMicros: intent.notionalLimitMicros,
  createdAt: intent.createdAt,
})

export const validateCommitIdentity = (
  inputIntent: unknown,
  inputDecision: unknown,
): Result.Result<PreparedCommit, CommitMaterialFailure> => {
  const intent = decodeIntentResult(inputIntent)
  if (Result.isFailure(intent)) return Result.fail({ _tag: 'IntentDecodeFailed', cause: intent.failure })
  const expectedIntent = makePaperIntentResult(planFromIntent(intent.success), intent.success.authorityGenerationHash)
  if (Result.isFailure(expectedIntent)) return Result.fail(expectedIntent.failure)
  if (!intentEquivalent(intent.success, expectedIntent.success)) {
    return Result.fail({ _tag: 'IntentIdentityMismatch', intentId: intent.success.intentId })
  }

  const decision = decodeRiskDecisionResult(inputDecision)
  if (Result.isFailure(decision)) return Result.fail({ _tag: 'RiskDecisionDecodeFailed', cause: decision.failure })
  const { decisionId, ...decisionMaterial } = decision.success
  const expectedDecisionId = canonicalHashResult(
    { _tag: 'RiskDecisionIdentity', decisionId, intentId: decision.success.intentId },
    decisionMaterial,
  )
  if (Result.isFailure(expectedDecisionId)) return Result.fail(expectedDecisionId.failure)
  if (decisionId !== expectedDecisionId.success) {
    return Result.fail({
      _tag: 'RiskDecisionIdentityMismatch',
      decisionId,
      expectedDecisionId: expectedDecisionId.success,
    })
  }
  if (
    decision.success.intentId !== intent.success.intentId ||
    decision.success.policyHash !== intent.success.policyHash
  ) {
    return Result.fail({
      _tag: 'RiskDecisionBindingMismatch',
      intentId: intent.success.intentId,
      decisionIntentId: decision.success.intentId,
      policyHash: intent.success.policyHash,
      decisionPolicyHash: decision.success.policyHash,
    })
  }
  return Result.succeed({ _tag: 'PreparedCommit', intent: intent.success, decision: decision.success })
}

const immutableIntentMaterial = (intent: Intent) => ({
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

const immutableIntentHashResult = (intent: Intent): Result.Result<string, IntentCanonicalizationFailure> =>
  canonicalHashResult({ _tag: 'ImmutableIntentContent', intentId: intent.intentId }, immutableIntentMaterial(intent))

export type ExistingCommitFailure =
  | IntentCanonicalizationFailure
  | { readonly _tag: 'MultipleIntentConflicts'; readonly count: number }
  | { readonly _tag: 'ImmutableIntentMismatch'; readonly intentId: string }
  | { readonly _tag: 'StoredDecisionMismatch'; readonly intentId: string; readonly decisionId: string }
  | {
      readonly _tag: 'IncompleteIntentState'
      readonly intentId: string
      readonly state: IntentState
      readonly riskDecisionId?: string
    }

export type ExistingCommitDisposition =
  | { readonly _tag: 'InsertIntent' }
  | { readonly _tag: 'CompleteIntent'; readonly record: StoredIntent }
  | { readonly _tag: 'ExactReplay'; readonly receipt: IntentReceipt }

const decisionStateMatches = (record: StoredIntent, decision: RiskDecision): boolean =>
  decision.outcome === RiskOutcome.Approved
    ? record.intent.state !== IntentState.Planned
    : record.intent.state === IntentState.Terminal && record.intent.terminalOutcome === TerminalOutcome.Blocked

export const classifyExistingCommit = (
  records: readonly StoredIntent[],
  prepared: PreparedCommit,
): Result.Result<ExistingCommitDisposition, ExistingCommitFailure> => {
  if (records.length === 0) return Result.succeed({ _tag: 'InsertIntent' })
  if (records.length > 1) return Result.fail({ _tag: 'MultipleIntentConflicts', count: records.length })
  const record = records[0]
  const storedHash = immutableIntentHashResult(record.intent)
  if (Result.isFailure(storedHash)) return Result.fail(storedHash.failure)
  const requestedHash = immutableIntentHashResult(prepared.intent)
  if (Result.isFailure(requestedHash)) return Result.fail(requestedHash.failure)
  if (storedHash.success !== requestedHash.success) {
    return Result.fail({ _tag: 'ImmutableIntentMismatch', intentId: prepared.intent.intentId })
  }
  if (record.decision !== undefined) {
    if (
      !decisionEquivalent(record.decision, prepared.decision) ||
      record.intent.riskDecisionId !== prepared.decision.decisionId ||
      !decisionStateMatches(record, prepared.decision)
    ) {
      return Result.fail({
        _tag: 'StoredDecisionMismatch',
        intentId: prepared.intent.intentId,
        decisionId: prepared.decision.decisionId,
      })
    }
    return Result.succeed({
      _tag: 'ExactReplay',
      receipt: { record, deduplicated: true },
    })
  }
  if (record.intent.state !== IntentState.Planned || record.intent.riskDecisionId !== undefined) {
    return Result.fail({
      _tag: 'IncompleteIntentState',
      intentId: prepared.intent.intentId,
      state: record.intent.state,
      ...(record.intent.riskDecisionId === undefined ? {} : { riskDecisionId: record.intent.riskDecisionId }),
    })
  }
  return Result.succeed({ _tag: 'CompleteIntent', record })
}

export type AuthorityBindingFailure =
  | { readonly _tag: 'AuthorityMissing' }
  | { readonly _tag: 'MultipleAuthorityRows'; readonly count: number }
  | { readonly _tag: 'MaximumAuthorityNotPaper'; readonly observed: Authority }
  | { readonly _tag: 'EffectiveAuthorityNotPaper'; readonly observed: Authority }
  | { readonly _tag: 'AuthorityKillNotClear'; readonly observed: KillState }
  | { readonly _tag: 'AuthorityGenerationMismatch'; readonly observed: string; readonly expected: string }
  | {
      readonly _tag: 'AuthorityGenerationHistoryMismatch'
      readonly generationHash: string
      readonly field: 'maximum' | 'accountId' | 'riskPolicyHash' | 'strategyName'
      readonly observed: string | null
      readonly expected: string
    }

export const decodeAuthorityBindingRows = (
  rows: unknown,
): Result.Result<
  readonly AuthorityBindingRow[],
  { readonly _tag: 'AuthorityRowsDecodeFailed'; readonly cause: unknown }
> =>
  Result.mapError(decodeAuthorityBindingRowsResult(rows), (cause) => ({
    _tag: 'AuthorityRowsDecodeFailed' as const,
    cause,
  }))

export const validateCurrentAuthority = (
  rows: readonly AuthorityBindingRow[],
  intent: Intent,
): Result.Result<
  { readonly _tag: 'CurrentPaperAuthority'; readonly binding: AuthorityBindingRow },
  AuthorityBindingFailure
> => {
  if (rows.length === 0) return Result.fail({ _tag: 'AuthorityMissing' })
  if (rows.length > 1) return Result.fail({ _tag: 'MultipleAuthorityRows', count: rows.length })
  const authority = rows[0]
  if (authority.maximum !== Authority.Paper) {
    return Result.fail({ _tag: 'MaximumAuthorityNotPaper', observed: authority.maximum })
  }
  if (authority.kill_state !== KillState.Clear) {
    return Result.fail({ _tag: 'AuthorityKillNotClear', observed: authority.kill_state })
  }
  if (authority.effective !== Authority.Paper) {
    return Result.fail({ _tag: 'EffectiveAuthorityNotPaper', observed: authority.effective })
  }
  if (authority.generation_hash !== intent.authorityGenerationHash) {
    return Result.fail({
      _tag: 'AuthorityGenerationMismatch',
      observed: authority.generation_hash,
      expected: intent.authorityGenerationHash,
    })
  }
  const generationFields = [
    ['maximum', authority.generation_maximum, Authority.Paper],
    ['accountId', authority.generation_account_id, intent.accountId],
    ['riskPolicyHash', authority.generation_risk_policy_hash, intent.policyHash],
    ['strategyName', authority.generation_strategy_name, intent.strategyName],
  ] as const
  const mismatch = generationFields.find(([, observed, expected]) => observed !== expected)
  if (mismatch !== undefined) {
    const [field, observed, expected] = mismatch
    return Result.fail({
      _tag: 'AuthorityGenerationHistoryMismatch',
      generationHash: authority.generation_hash,
      field,
      observed,
      expected,
    })
  }
  return Result.succeed({ _tag: 'CurrentPaperAuthority', binding: authority })
}

export type WriteDispositionFailure =
  | {
      readonly _tag: 'ReturningRowsDecodeFailed'
      readonly write: 'intent' | 'decision' | 'transition'
      readonly cause: unknown
    }
  | {
      readonly _tag: 'UnexpectedReturningRows'
      readonly write: 'intent' | 'decision' | 'transition'
      readonly expectedId: string
      readonly observedIds: readonly string[]
    }

export type IntentInsertDisposition =
  | { readonly _tag: 'IntentInserted'; readonly intentId: string }
  | { readonly _tag: 'IntentInsertConflict'; readonly intentId: string }

export const decideIntentInsert = (
  rows: unknown,
  expectedIntentId: string,
): Result.Result<IntentInsertDisposition, WriteDispositionFailure> => {
  const decoded = decodeIntentReturningRowsResult(rows)
  if (Result.isFailure(decoded)) {
    return Result.fail({ _tag: 'ReturningRowsDecodeFailed', write: 'intent', cause: decoded.failure })
  }
  if (decoded.success.length === 0) {
    return Result.succeed({ _tag: 'IntentInsertConflict', intentId: expectedIntentId })
  }
  if (decoded.success.length === 1 && decoded.success[0].intent_id === expectedIntentId) {
    return Result.succeed({ _tag: 'IntentInserted', intentId: expectedIntentId })
  }
  return Result.fail({
    _tag: 'UnexpectedReturningRows',
    write: 'intent',
    expectedId: expectedIntentId,
    observedIds: decoded.success.map((row) => row.intent_id),
  })
}

export const decideRiskCommit = (
  rows: unknown,
  expectedDecisionId: string,
): Result.Result<{ readonly _tag: 'RiskDecisionInserted'; readonly decisionId: string }, WriteDispositionFailure> => {
  const decoded = decodeDecisionReturningRowsResult(rows)
  if (Result.isFailure(decoded)) {
    return Result.fail({ _tag: 'ReturningRowsDecodeFailed', write: 'decision', cause: decoded.failure })
  }
  if (decoded.success.length === 1 && decoded.success[0].decision_id === expectedDecisionId) {
    return Result.succeed({ _tag: 'RiskDecisionInserted', decisionId: expectedDecisionId })
  }
  return Result.fail({
    _tag: 'UnexpectedReturningRows',
    write: 'decision',
    expectedId: expectedDecisionId,
    observedIds: decoded.success.map((row) => row.decision_id),
  })
}

export const decideIntentTransition = (
  rows: unknown,
  expectedIntentId: string,
): Result.Result<{ readonly _tag: 'IntentTransitioned'; readonly intentId: string }, WriteDispositionFailure> => {
  const decoded = decodeIntentReturningRowsResult(rows)
  if (Result.isFailure(decoded)) {
    return Result.fail({ _tag: 'ReturningRowsDecodeFailed', write: 'transition', cause: decoded.failure })
  }
  if (decoded.success.length === 1 && decoded.success[0].intent_id === expectedIntentId) {
    return Result.succeed({ _tag: 'IntentTransitioned', intentId: expectedIntentId })
  }
  return Result.fail({
    _tag: 'UnexpectedReturningRows',
    write: 'transition',
    expectedId: expectedIntentId,
    observedIds: decoded.success.map((row) => row.intent_id),
  })
}

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

const storeError = (
  failure: IntentStoreError['failure'],
  operation: IntentStoreError['operation'],
  message: string,
  cause?: unknown,
) => new IntentStoreError({ failure, operation, message, cause })

const renderCommitMaterialFailure = (failure: CommitMaterialFailure): string => {
  switch (failure._tag) {
    case 'IntentDecodeFailed':
      return 'planned intent failed schema decoding'
    case 'RiskDecisionDecodeFailed':
      return 'risk decision failed schema decoding'
    case 'ConstructedIntentDecodeFailed':
      return `constructed ${failure.intentKind} intent failed schema decoding`
    case 'CanonicalizationFailed':
      return `canonical ${failure.material._tag} hashing failed`
    case 'IntentIdentityMismatch':
      return `planned intent ${failure.intentId} does not match its deterministic identity`
    case 'RiskDecisionIdentityMismatch':
      return `risk decision ${failure.decisionId} does not match deterministic identity ${failure.expectedDecisionId}`
    case 'RiskDecisionBindingMismatch':
      return `risk decision is not bound to intent ${failure.intentId} and policy ${failure.policyHash}`
  }
}

const commitMaterialError = (failure: CommitMaterialFailure): IntentStoreError => {
  const kind =
    failure._tag === 'IntentDecodeFailed' ||
    failure._tag === 'RiskDecisionDecodeFailed' ||
    failure._tag === 'ConstructedIntentDecodeFailed'
      ? 'decode'
      : 'invariant'
  return storeError(kind, 'commit', renderCommitMaterialFailure(failure), failure)
}

const existingCommitError = (failure: ExistingCommitFailure): IntentStoreError => {
  switch (failure._tag) {
    case 'CanonicalizationFailed':
      return storeError('invariant', 'commit', `canonical ${failure.material._tag} hashing failed`, failure)
    case 'MultipleIntentConflicts':
      return storeError(
        'conflict',
        'commit',
        `intent uniqueness boundary resolved to ${failure.count} records`,
        failure,
      )
    case 'ImmutableIntentMismatch':
      return storeError(
        'conflict',
        'commit',
        `deterministic intent identity ${failure.intentId} was reused with different content`,
        failure,
      )
    case 'StoredDecisionMismatch':
      return storeError(
        'conflict',
        'commit',
        `stored intent ${failure.intentId} diverges from decision ${failure.decisionId}`,
        failure,
      )
    case 'IncompleteIntentState':
      return storeError('invariant', 'commit', `intent ${failure.intentId} without a decision is not PLANNED`, failure)
  }
}

const authorityError = (failure: AuthorityBindingFailure): IntentStoreError => {
  switch (failure._tag) {
    case 'AuthorityMissing':
      return storeError('invariant', 'commit', 'PAPER authority is not initialized', failure)
    case 'MultipleAuthorityRows':
      return storeError('invariant', 'commit', 'PAPER authority singleton returned multiple rows', failure)
    case 'MaximumAuthorityNotPaper':
      return storeError('invariant', 'commit', 'GitOps maximum authority is not PAPER', failure)
    case 'EffectiveAuthorityNotPaper':
      return storeError('invariant', 'commit', 'effective authority is not PAPER', failure)
    case 'AuthorityKillNotClear':
      return storeError('invariant', 'commit', 'PAPER authority kill is not CLEAR', failure)
    case 'AuthorityGenerationMismatch':
      return storeError('invariant', 'commit', 'intent does not bind the active PAPER generation', failure)
    case 'AuthorityGenerationHistoryMismatch':
      return storeError(
        'invariant',
        'commit',
        `active PAPER generation ${failure.generationHash} has mismatched ${failure.field}`,
        failure,
      )
  }
}

const writeDispositionError = (failure: WriteDispositionFailure): IntentStoreError =>
  failure._tag === 'ReturningRowsDecodeFailed'
    ? storeError('decode', 'commit', `${failure.write} RETURNING rows failed schema decoding`, failure)
    : storeError(
        'conflict',
        'commit',
        `${failure.write} did not return the exact expected identity ${failure.expectedId}`,
        failure,
      )

const storedRowsError = (operation: IntentStoreError['operation'], failure: StoredRowsFailure): IntentStoreError => {
  switch (failure._tag) {
    case 'StoredRowsDecodeFailed':
      return storeError('decode', operation, 'stored intent rows failed schema decoding', failure)
    case 'StoredIntentDecodeFailed':
      return storeError('decode', operation, `stored intent ${failure.intentId} failed schema decoding`, failure)
    case 'StoredRiskDecisionDecodeFailed':
      return storeError('decode', operation, `stored decision for ${failure.intentId} failed schema decoding`, failure)
  }
}

const classifyIntentCause = (operation: IntentStoreError['operation'], cause: unknown): IntentStoreError => {
  if (cause instanceof IntentStoreError) return cause
  if (isSqlError(cause)) {
    if (cause.reason._tag === 'UniqueViolation') {
      return storeError('conflict', operation, `intent ${operation} violated a uniqueness boundary`, cause)
    }
    if (cause.reason._tag === 'ConstraintError') {
      return storeError('invariant', operation, `intent ${operation} violated a durable semantic constraint`, cause)
    }
  }
  return storeError('query', operation, `intent ${operation} failed`, cause)
}

const classifyCommitCause = (cause: unknown): IntentStoreError | WriterFenceError =>
  cause instanceof WriterFenceError ? cause : classifyIntentCause('commit', cause)

const runRead = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, IntentStoreError, R> =>
  effect.pipe(Effect.mapError((cause) => classifyIntentCause('read', cause)))

const runCommit = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, IntentStoreError | WriterFenceError, R> =>
  effect.pipe(Effect.mapError(classifyCommitCause))

const decodeStoredEffect = (
  operation: IntentStoreError['operation'],
  rows: unknown,
): Effect.Effect<readonly StoredIntent[], IntentStoreError> =>
  Effect.fromResult(decodeStoredIntentRows(rows)).pipe(
    Effect.mapError((failure) => storedRowsError(operation, failure)),
  )

const readById = (
  sql: PgClient.PgClient,
  operation: IntentStoreError['operation'],
  intentId: string,
): Effect.Effect<Option.Option<StoredIntent>, IntentStoreError, never> => {
  const decodedId = Result.mapError(decodeIntentIdResult(intentId), (cause) =>
    storeError('decode', operation, 'invalid intent ID', cause),
  )
  return Effect.fromResult(decodedId).pipe(
    Effect.flatMap((id) =>
      selectRows(sql, sql`intent.intent_id = ${id}`).pipe(
        Effect.mapError((cause) => classifyIntentCause(operation, cause)),
      ),
    ),
    Effect.flatMap((rows) => decodeStoredEffect(operation, rows)),
    Effect.flatMap((records) =>
      records.length <= 1
        ? Effect.succeed(Option.fromNullishOr(records[0]))
        : Effect.fail(storeError('invariant', operation, 'intent ID returned multiple records')),
    ),
  )
}

const readConflicts = (
  sql: PgClient.PgClient,
  intent: Intent,
): Effect.Effect<readonly StoredIntent[], IntentStoreError> =>
  selectRows(
    sql,
    sql`
      intent.intent_id = ${intent.intentId}
      OR (intent.account_id = ${intent.accountId} AND intent.client_order_id = ${intent.clientOrderId})
      OR (
        intent.account_id = ${intent.accountId}
        AND intent.strategy_name = ${intent.strategyName}
        AND intent.cycle_id = ${intent.cycleId}
        AND intent.decision_hash = ${intent.decisionHash}
        AND intent.symbol = ${intent.symbol}
      )
    `,
  ).pipe(
    Effect.mapError((cause) => classifyIntentCause('commit', cause)),
    Effect.flatMap((rows) => decodeStoredEffect('commit', rows)),
  )

const readCurrentAuthority = (
  sql: PgClient.PgClient,
): Effect.Effect<readonly AuthorityBindingRow[], IntentStoreError> =>
  sql`
    SELECT
      authority.maximum,
      authority.effective,
      authority.kill_state,
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
  `.pipe(
    Effect.mapError((cause) => classifyIntentCause('commit', cause)),
    Effect.flatMap((rows) =>
      Effect.fromResult(decodeAuthorityBindingRows(rows)).pipe(
        Effect.mapError((failure) =>
          storeError('decode', 'commit', 'authority binding rows failed schema decoding', failure),
        ),
      ),
    ),
  )

const insertIntent = (sql: PgClient.PgClient, intent: Intent) =>
  sql`
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
      ${intent.intentId},
      ${intent.schemaVersion},
      ${intent.authorityGenerationHash},
      ${intent.strategyName},
      ${intent.cycleId},
      ${intent.decisionHash},
      ${intent.policyHash},
      ${intent.accountId},
      ${intent.clientOrderId},
      ${intent.symbol},
      ${intent.side},
      ${intent.orderType},
      ${intent.timeInForce},
      ${intent.quantityMicros},
      ${intent.notionalLimitMicros},
      ${intent.state},
      ${intent.createdAt},
      ${intent.createdAt}
    )
    ON CONFLICT DO NOTHING
    RETURNING intent_id
  `.pipe(Effect.mapError((cause) => classifyIntentCause('commit', cause)))

const insertRiskDecision = (sql: PgClient.PgClient, decision: RiskDecision) =>
  sql`
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
  `.pipe(Effect.mapError((cause) => classifyIntentCause('commit', cause)))

const transitionIntent = (sql: PgClient.PgClient, intent: Intent, decision: RiskDecision) => {
  const approved = decision.outcome === RiskOutcome.Approved
  return sql`
    UPDATE intents
    SET
      risk_decision_id = ${decision.decisionId},
      state = ${approved ? IntentState.Approved : IntentState.Terminal},
      terminal_outcome = ${approved ? null : TerminalOutcome.Blocked},
      state_version = state_version + 1,
      updated_at = ${decision.decidedAt}
    WHERE intent_id = ${intent.intentId} AND state = ${IntentState.Planned}
    RETURNING intent_id
  `.pipe(Effect.mapError((cause) => classifyIntentCause('commit', cause)))
}

type ResolvedIntent =
  | { readonly _tag: 'Replay'; readonly receipt: IntentReceipt }
  | { readonly _tag: 'Pending'; readonly record: StoredIntent }

const resolveDisposition = (
  disposition: ExistingCommitDisposition,
): Effect.Effect<ResolvedIntent, IntentStoreError> => {
  if (disposition._tag === 'ExactReplay') {
    return Effect.succeed({ _tag: 'Replay', receipt: disposition.receipt })
  }
  if (disposition._tag === 'CompleteIntent') {
    return Effect.succeed({ _tag: 'Pending', record: disposition.record })
  }
  return Effect.fail(storeError('conflict', 'commit', 'inserted intent cannot be read back'))
}

const reclassifyAfterInsert = (
  sql: PgClient.PgClient,
  prepared: PreparedCommit,
): Effect.Effect<ResolvedIntent, IntentStoreError> =>
  readConflicts(sql, prepared.intent).pipe(
    Effect.flatMap((records) =>
      Effect.fromResult(classifyExistingCommit(records, prepared)).pipe(Effect.mapError(existingCommitError)),
    ),
    Effect.flatMap(resolveDisposition),
  )

const resolveIntent = (
  sql: PgClient.PgClient,
  prepared: PreparedCommit,
): Effect.Effect<ResolvedIntent, IntentStoreError> =>
  Effect.gen(function* () {
    const records = yield* readConflicts(sql, prepared.intent)
    const disposition = yield* Effect.fromResult(classifyExistingCommit(records, prepared)).pipe(
      Effect.mapError(existingCommitError),
    )
    if (disposition._tag === 'ExactReplay') {
      return { _tag: 'Replay', receipt: disposition.receipt } satisfies ResolvedIntent
    }

    const authorityRows = yield* readCurrentAuthority(sql)
    yield* Effect.fromResult(validateCurrentAuthority(authorityRows, prepared.intent)).pipe(
      Effect.mapError(authorityError),
    )
    if (disposition._tag === 'CompleteIntent') {
      return { _tag: 'Pending', record: disposition.record } satisfies ResolvedIntent
    }

    const insertedRows = yield* insertIntent(sql, prepared.intent)
    yield* Effect.fromResult(decideIntentInsert(insertedRows, prepared.intent.intentId)).pipe(
      Effect.mapError(writeDispositionError),
    )
    return yield* reclassifyAfterInsert(sql, prepared)
  })

const persistDecision = (
  sql: PgClient.PgClient,
  prepared: PreparedCommit,
): Effect.Effect<IntentReceipt, IntentStoreError> =>
  Effect.gen(function* () {
    const decisionRows = yield* insertRiskDecision(sql, prepared.decision)
    yield* Effect.fromResult(decideRiskCommit(decisionRows, prepared.decision.decisionId)).pipe(
      Effect.mapError(writeDispositionError),
    )
    const transitionRows = yield* transitionIntent(sql, prepared.intent, prepared.decision)
    yield* Effect.fromResult(decideIntentTransition(transitionRows, prepared.intent.intentId)).pipe(
      Effect.mapError(writeDispositionError),
    )
    const stored = yield* readById(sql, 'commit', prepared.intent.intentId)
    if (Option.isNone(stored)) {
      return yield* Effect.fail(storeError('invariant', 'commit', 'committed intent cannot be read back'))
    }
    const verified = yield* Effect.fromResult(classifyExistingCommit([stored.value], prepared)).pipe(
      Effect.mapError(existingCommitError),
    )
    if (verified._tag !== 'ExactReplay') {
      return yield* Effect.fail(storeError('invariant', 'commit', 'committed intent readback is incomplete'))
    }
    return { record: verified.receipt.record, deduplicated: false }
  })

const commitTransaction = (
  sql: PgClient.PgClient,
  prepared: PreparedCommit,
): Effect.Effect<IntentReceipt, IntentStoreError> =>
  resolveIntent(sql, prepared).pipe(
    Effect.flatMap((resolved) =>
      resolved._tag === 'Replay' ? Effect.succeed(resolved.receipt) : persistDecision(sql, prepared),
    ),
  )

const makeStore = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const fence = yield* WriterFence
  return {
    commit: (intent, decision) =>
      runCommit(
        Effect.fromResult(validateCommitIdentity(intent, decision)).pipe(
          Effect.mapError(commitMaterialError),
          Effect.flatMap((prepared) => fence.transaction(commitTransaction(sql, prepared))),
        ),
      ),
    read: (intentId) => runRead(readById(sql, 'read', intentId)),
  } satisfies IntentStoreService
})

export const IntentStoreLive = Layer.effect(IntentStore, makeStore)
