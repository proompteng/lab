import { Context, Data, Effect, Option, Result, Schema } from 'effect'

import { canonicalHashV1Result, type CanonicalHashFailure } from '../../hash'
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
} from '../contracts'
import type { State } from '../../risk'
import {
  Sha256Schema as Sha256,
  StrictNonEmptyStringSchema as NonEmptyString,
  SymbolSchema as SymbolName,
  UtcInstantSchema as UtcInstant,
  strictParseOptions,
} from '../../schemas'
import { WriterFenceError } from '../writer-fence'
import { Pipeable } from '../../pipeable'

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
  /** Binds a residual close intent to the immediately preceding close-plan generation. */
  replanGenerationHash: Schema.optionalKey(Sha256),
  createdAt: UtcInstant,
})
export type IntentPlan = typeof IntentPlanSchema.Type

const decodePlanResult = Schema.decodeUnknownResult(IntentPlanSchema, strictParseOptions)
const decodeAuthorityGenerationHashResult = Schema.decodeUnknownResult(Sha256, strictParseOptions)
const decodeIntentResult = Schema.decodeUnknownResult(IntentSchema, strictParseOptions)
const decodeRiskDecisionResult = Schema.decodeUnknownResult(RiskDecisionSchema, strictParseOptions)
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
      readonly replanGenerationHash?: string
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
  schemaVersion:
    input.replanGenerationHash === undefined ? 'bayn.paper-intent-identity.v2' : 'bayn.paper-intent-identity.v3',
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
  ...(input.replanGenerationHash === undefined ? {} : { replanGenerationHash: input.replanGenerationHash }),
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
      ...(input.replanGenerationHash === undefined ? {} : { replanGenerationHash: input.replanGenerationHash }),
    },
    paperIdentityMaterial(input, authorityGenerationHash),
  )

export const paperIntentIdForDecodedPlan = Pipeable.dual(2, paperIntentIdResult)

export const intentIdForPlan = referenceIntentIdResult

const base64UrlAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

const base64UrlEncodeHex = (value: string): string => {
  let encoded = ''
  for (let index = 0; index < value.length; index += 6) {
    const first = Number.parseInt(value.slice(index, index + 2), 16)
    const secondHex = value.slice(index + 2, index + 4)
    const thirdHex = value.slice(index + 4, index + 6)
    const second = secondHex === '' ? undefined : Number.parseInt(secondHex, 16)
    const third = thirdHex === '' ? undefined : Number.parseInt(thirdHex, 16)
    encoded += base64UrlAlphabet[first >> 2]
    encoded += base64UrlAlphabet[((first & 0b11) << 4) | ((second ?? 0) >> 4)]
    if (second === undefined) continue
    encoded += base64UrlAlphabet[((second & 0b1111) << 2) | ((third ?? 0) >> 6)]
    if (third !== undefined) encoded += base64UrlAlphabet[third & 0b111111]
  }
  return encoded
}

export const clientOrderIdForIntentId = (intentId: string): string => `b1_${base64UrlEncodeHex(intentId)}`

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
      clientOrderId: clientOrderIdForIntentId(intentId.success),
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
      clientOrderId: clientOrderIdForIntentId(intentId.success),
      symbol: decoded.symbol,
      side: decoded.side,
      orderType: decoded.orderType,
      timeInForce: decoded.timeInForce,
      quantityMicros: decoded.quantityMicros,
      notionalLimitMicros: decoded.notionalLimitMicros,
      ...(decoded.replanGenerationHash === undefined ? {} : { replanGenerationHash: decoded.replanGenerationHash }),
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

const paperIntentIdForPlanDataFirst = (
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

export const paperIntentIdForPlan = Pipeable.dual(2, paperIntentIdForPlanDataFirst)

export class PaperIntentBindingError extends Data.TaggedError('PaperIntentBindingError')<{
  readonly message: string
}> {}

const planPaperIntentDataFirst = (
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

export const planPaperIntent = Pipeable.dual(2, planPaperIntentDataFirst)

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
  /** Commits a pre-registered sell-only close intent after effective PAPER is restricted. */
  readonly commitClosing?: (
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
  replan_generation_hash: Schema.NullOr(Sha256),
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
    ...(row.replan_generation_hash === null ? {} : { replanGenerationHash: row.replan_generation_hash }),
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
  ...(intent.replanGenerationHash === undefined ? {} : { replanGenerationHash: intent.replanGenerationHash }),
  createdAt: intent.createdAt,
})

const validateCommitIdentityDataFirst = (
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

export const validateCommitIdentity = Pipeable.dual(2, validateCommitIdentityDataFirst)

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
  ...(intent.replanGenerationHash === undefined ? {} : { replanGenerationHash: intent.replanGenerationHash }),
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

const classifyExistingCommitDataFirst = (
  records: readonly StoredIntent[],
  prepared: PreparedCommit,
): Result.Result<ExistingCommitDisposition, ExistingCommitFailure> => {
  if (records.length === 0) return Result.succeed({ _tag: 'InsertIntent' })
  if (records.length > 1) return Result.fail({ _tag: 'MultipleIntentConflicts', count: records.length })
  const [record] = records
  if (record === undefined) return Result.succeed({ _tag: 'InsertIntent' })
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

export const classifyExistingCommit = Pipeable.dual(2, classifyExistingCommitDataFirst)

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
  | { readonly _tag: 'ClosingIntentMustSell' }

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

const validateCurrentAuthorityDataFirst = (
  rows: readonly AuthorityBindingRow[],
  intent: Intent,
): Result.Result<
  { readonly _tag: 'CurrentCapitalGrant'; readonly binding: AuthorityBindingRow },
  AuthorityBindingFailure
> => {
  if (rows.length === 0) return Result.fail({ _tag: 'AuthorityMissing' })
  if (rows.length > 1) return Result.fail({ _tag: 'MultipleAuthorityRows', count: rows.length })
  const [authority] = rows
  if (authority === undefined) return Result.fail({ _tag: 'AuthorityMissing' })
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
  return Result.succeed({ _tag: 'CurrentCapitalGrant', binding: authority })
}

export const validateCurrentAuthority = Pipeable.dual(2, validateCurrentAuthorityDataFirst)

const validateCurrentClosingAuthorityDataFirst = (
  rows: readonly AuthorityBindingRow[],
  intent: Intent,
): Result.Result<
  { readonly _tag: 'CurrentCapitalGrant'; readonly binding: AuthorityBindingRow },
  AuthorityBindingFailure
> => {
  if (intent.side !== 'SELL') return Result.fail({ _tag: 'ClosingIntentMustSell' })
  if (rows.length === 0) return Result.fail({ _tag: 'AuthorityMissing' })
  if (rows.length > 1) return Result.fail({ _tag: 'MultipleAuthorityRows', count: rows.length })
  const [authority] = rows
  if (authority === undefined) return Result.fail({ _tag: 'AuthorityMissing' })
  if (authority.maximum !== Authority.Paper) {
    return Result.fail({ _tag: 'MaximumAuthorityNotPaper', observed: authority.maximum })
  }
  if (authority.kill_state !== KillState.Clear && authority.kill_state !== KillState.Active) {
    return Result.fail({ _tag: 'AuthorityKillNotClear', observed: authority.kill_state })
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
  return Result.succeed({ _tag: 'CurrentCapitalGrant', binding: authority })
}

export const validateCurrentClosingAuthority = Pipeable.dual(2, validateCurrentClosingAuthorityDataFirst)

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

const decideIntentInsertDataFirst = (
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
  const [inserted] = decoded.success
  if (decoded.success.length === 1 && inserted?.intent_id === expectedIntentId) {
    return Result.succeed({ _tag: 'IntentInserted', intentId: expectedIntentId })
  }
  return Result.fail({
    _tag: 'UnexpectedReturningRows',
    write: 'intent',
    expectedId: expectedIntentId,
    observedIds: decoded.success.map((row) => row.intent_id),
  })
}

export const decideIntentInsert = Pipeable.dual(2, decideIntentInsertDataFirst)

const decideRiskCommitDataFirst = (
  rows: unknown,
  expectedDecisionId: string,
): Result.Result<{ readonly _tag: 'RiskDecisionInserted'; readonly decisionId: string }, WriteDispositionFailure> => {
  const decoded = decodeDecisionReturningRowsResult(rows)
  if (Result.isFailure(decoded)) {
    return Result.fail({ _tag: 'ReturningRowsDecodeFailed', write: 'decision', cause: decoded.failure })
  }
  const [inserted] = decoded.success
  if (decoded.success.length === 1 && inserted?.decision_id === expectedDecisionId) {
    return Result.succeed({ _tag: 'RiskDecisionInserted', decisionId: expectedDecisionId })
  }
  return Result.fail({
    _tag: 'UnexpectedReturningRows',
    write: 'decision',
    expectedId: expectedDecisionId,
    observedIds: decoded.success.map((row) => row.decision_id),
  })
}

export const decideRiskCommit = Pipeable.dual(2, decideRiskCommitDataFirst)

const decideIntentTransitionDataFirst = (
  rows: unknown,
  expectedIntentId: string,
): Result.Result<{ readonly _tag: 'IntentTransitioned'; readonly intentId: string }, WriteDispositionFailure> => {
  const decoded = decodeIntentReturningRowsResult(rows)
  if (Result.isFailure(decoded)) {
    return Result.fail({ _tag: 'ReturningRowsDecodeFailed', write: 'transition', cause: decoded.failure })
  }
  const [transitioned] = decoded.success
  if (decoded.success.length === 1 && transitioned?.intent_id === expectedIntentId) {
    return Result.succeed({ _tag: 'IntentTransitioned', intentId: expectedIntentId })
  }
  return Result.fail({
    _tag: 'UnexpectedReturningRows',
    write: 'transition',
    expectedId: expectedIntentId,
    observedIds: decoded.success.map((row) => row.intent_id),
  })
}

export const decideIntentTransition = Pipeable.dual(2, decideIntentTransitionDataFirst)
