import assert from 'node:assert/strict'

import { describe, expect, test } from 'bun:test'

import { Effect, Exit, Result } from 'effect'

import {
  Authority,
  IntentState,
  KillState,
  OrderSide,
  OrderType,
  RiskOutcome,
  TerminalOutcome,
  TimeInForce,
  type Intent,
  type RiskDecision,
} from './contracts'
import {
  classifyExistingCommit,
  decodeAuthorityBindingRows,
  decodeStoredIntentRows,
  decideIntentInsert,
  decideIntentTransition,
  decideRiskCommit,
  intentIdForPlan,
  executionIntentIdForPlan,
  plan,
  planExecutionIntent,
  validateCommitIdentity,
  validateCurrentAuthority,
  validateCurrentClosingAuthority,
  type AuthorityBindingRow,
  type IntentPlan,
  type PreparedCommit,
  type StoredIntent,
} from './intents'

const hash = (digit: string): string => digit.repeat(64)

const input: IntentPlan = {
  schemaVersion: 'bayn.paper-intent-plan.v1',
  strategyName: 'risk-balanced-trend',
  cycleId: hash('1'),
  decisionHash: hash('2'),
  policyHash: hash('3'),
  accountId: 'paper-account-1',
  symbol: 'NVDA',
  side: OrderSide.Buy,
  orderType: OrderType.Market,
  timeInForce: TimeInForce.Day,
  quantityMicros: '1000000',
  notionalLimitMicros: '200000000',
  createdAt: '2026-07-22T10:00:00.000Z',
}

const riskState = (generationHash = hash('a'), maximum = Authority.Execution) => ({
  authority: {
    schemaVersion: 'bayn.paper-authority.v1' as const,
    generationHash,
    maximum,
    effective: maximum,
    kill: KillState.Clear,
    version: 1,
    updatedAt: '2026-07-22T09:59:00.000Z',
  },
})

const paperIntent: Intent = {
  schemaVersion: 'bayn.paper-intent.v3',
  authorityGenerationHash: hash('a'),
  intentId: '6f3b7a528607ed8804f55c5fe23a0c47a4d6f72abf2bb9a41a69d93368d9c8ac',
  strategyName: input.strategyName,
  cycleId: input.cycleId,
  decisionHash: input.decisionHash,
  policyHash: input.policyHash,
  accountId: input.accountId,
  clientOrderId: 'b1_bzt6UoYH7YgE9Vxf4joMR6TW9yq_K7mkGmnZM2jZyKw',
  symbol: input.symbol,
  side: input.side,
  orderType: input.orderType,
  timeInForce: input.timeInForce,
  quantityMicros: input.quantityMicros,
  notionalLimitMicros: input.notionalLimitMicros,
  state: IntentState.Planned,
  createdAt: input.createdAt,
}

const approvedDecision: RiskDecision = {
  schemaVersion: 'bayn.paper-risk-decision.v1',
  decisionId: 'dfb3ec0a5fda18eb05a9869870039f694c18d3639907963ef26e5a9cafcd50cd',
  inputHash: hash('d'),
  intentId: paperIntent.intentId,
  policyHash: paperIntent.policyHash,
  outcome: RiskOutcome.Approved,
  reasonCodes: [],
  decidedAt: '2026-07-22T10:00:01.000Z',
  expiresAt: '2026-07-22T10:05:01.000Z',
}

const preparedCommit = (): PreparedCommit => {
  const prepared = validateCommitIdentity(paperIntent, approvedDecision)
  assert(Result.isSuccess(prepared))
  return prepared.success
}

const storedIntent = (
  state: IntentState,
  decision: RiskDecision | undefined,
  terminalOutcome?: TerminalOutcome,
): StoredIntent => ({
  intent: {
    ...paperIntent,
    ...(decision === undefined ? {} : { riskDecisionId: decision.decisionId }),
    state,
    ...(terminalOutcome === undefined ? {} : { terminalOutcome }),
  },
  ...(decision === undefined ? {} : { decision }),
  stateVersion: decision === undefined ? 1 : 2,
  updatedAt: decision?.decidedAt ?? paperIntent.createdAt,
})

const authorityRow = (overrides: Partial<AuthorityBindingRow> = {}): AuthorityBindingRow => ({
  maximum: Authority.Execution,
  effective: Authority.Execution,
  kill_state: KillState.Clear,
  generation_hash: paperIntent.authorityGenerationHash,
  generation_maximum: Authority.Execution,
  generation_account_id: paperIntent.accountId,
  generation_risk_policy_hash: paperIntent.policyHash,
  generation_strategy_name: paperIntent.strategyName,
  ...overrides,
})

const storedRow = {
  schema_version: paperIntent.schemaVersion,
  intent_id: paperIntent.intentId,
  risk_decision_id: approvedDecision.decisionId,
  authority_generation_hash: paperIntent.authorityGenerationHash,
  strategy_name: paperIntent.strategyName,
  cycle_id: paperIntent.cycleId,
  decision_hash: paperIntent.decisionHash,
  policy_hash: paperIntent.policyHash,
  account_id: paperIntent.accountId,
  client_order_id: paperIntent.clientOrderId,
  symbol: paperIntent.symbol,
  side: paperIntent.side,
  order_type: paperIntent.orderType,
  time_in_force: paperIntent.timeInForce,
  quantity_micros: paperIntent.quantityMicros,
  notional_limit_micros: paperIntent.notionalLimitMicros,
  replan_generation_hash: null,
  state: IntentState.Approved,
  terminal_outcome: null,
  state_version: 2,
  created_at: paperIntent.createdAt,
  updated_at: approvedDecision.decidedAt,
  decision_id: approvedDecision.decisionId,
  input_hash: approvedDecision.inputHash,
  decision_policy_hash: approvedDecision.policyHash,
  outcome: approvedDecision.outcome,
  reason_codes: approvedDecision.reasonCodes,
  decided_at: approvedDecision.decidedAt,
  expires_at: approvedDecision.expiresAt,
}

describe('deterministic execution intents', () => {
  test('derives one stable full intent identity and Alpaca-bounded client order ID', async () => {
    const [first, second] = await Effect.runPromise(Effect.all([plan(input), plan({ ...input })]))

    expect(first).toEqual(second)
    expect(first.intentId).toMatch(/^[0-9a-f]{64}$/)
    expect(first.clientOrderId).toMatch(/^b1_[A-Za-z0-9_-]{43}$/)
    expect(first.clientOrderId).toHaveLength(46)
    expect(first.state).toBe(IntentState.Planned)
    expect(first.riskDecisionId).toBeUndefined()
    expect(first.schemaVersion).toBe('bayn.paper-intent.v2')
  })

  test('binds account, strategy, cycle, decision, and target material', async () => {
    const baseline = await Effect.runPromise(plan(input))
    const variants: readonly IntentPlan[] = [
      { ...input, accountId: 'paper-account-2' },
      { ...input, strategyName: 'another-strategy' },
      { ...input, cycleId: hash('4') },
      { ...input, decisionHash: hash('5') },
      { ...input, symbol: 'AMD' },
      { ...input, side: OrderSide.Sell },
      { ...input, orderType: OrderType.Limit },
      { ...input, timeInForce: TimeInForce.GoodUntilCanceled },
      { ...input, quantityMicros: '2000000' },
      { ...input, notionalLimitMicros: '300000000' },
    ]
    const planned = await Effect.runPromise(Effect.forEach(variants, plan))

    expect(new Set(planned.map((intent) => intent.intentId)).size).toBe(variants.length)
    expect(planned.every((intent) => intent.intentId !== baseline.intentId)).toBe(true)
    expect(planned.every((intent) => intent.clientOrderId !== baseline.clientOrderId)).toBe(true)
  })

  test('keeps the order identity stable when policy or observation time drifts', async () => {
    const [baseline, changedPolicy, changedTime] = await Effect.runPromise(
      Effect.all([
        plan(input),
        plan({ ...input, policyHash: hash('6') }),
        plan({ ...input, createdAt: '2026-07-22T10:00:01.000Z' }),
      ]),
    )

    expect(changedPolicy.intentId).toBe(baseline.intentId)
    expect(changedPolicy.clientOrderId).toBe(baseline.clientOrderId)
    expect(changedTime.intentId).toBe(baseline.intentId)
    expect(changedTime.clientOrderId).toBe(baseline.clientOrderId)
  })

  test('rejects malformed plans before deriving an identity', async () => {
    const result = await Effect.runPromiseExit(
      plan({ ...input, cycleId: 'not-a-hash', quantityMicros: '0', extra: true }),
    )

    expect(Exit.isFailure(result)).toBe(true)
  })

  test('binds a durable execution identity to the exact risk-state authority generation', async () => {
    const [first, replay, rotated, derivedId] = await Effect.runPromise(
      Effect.all([
        planExecutionIntent(input, riskState()),
        planExecutionIntent({ ...input }, riskState()),
        planExecutionIntent(input, riskState(hash('b'))),
        executionIntentIdForPlan(input, hash('a')),
      ]),
    )

    expect(first).toEqual(replay)
    expect(derivedId).toBe(first.intentId)
    expect(first).toMatchObject({
      schemaVersion: 'bayn.paper-intent.v3',
      authorityGenerationHash: hash('a'),
      state: IntentState.Planned,
    })
    expect(rotated.authorityGenerationHash).toBe(hash('b'))
    expect(rotated.intentId).not.toBe(first.intentId)
    expect(rotated.clientOrderId).not.toBe(first.clientOrderId)
  })

  test('derives the v3 identity without authority state and rejects malformed material', async () => {
    const [baseline, changedTime, changedGeneration] = await Effect.runPromise(
      Effect.all([
        executionIntentIdForPlan(input, hash('a')),
        executionIntentIdForPlan({ ...input, createdAt: '2026-07-22T10:00:01.000Z' }, hash('a')),
        executionIntentIdForPlan(input, hash('b')),
      ]),
    )

    expect(changedTime).toBe(baseline)
    expect(changedGeneration).not.toBe(baseline)
    expect(
      Exit.isFailure(await Effect.runPromiseExit(executionIntentIdForPlan({ ...input, extra: true }, hash('a')))),
    ).toBe(true)
    expect(Exit.isFailure(await Effect.runPromiseExit(executionIntentIdForPlan(input, 'not-a-hash')))).toBe(true)
  })

  test('binds each residual close generation to a distinct execution intent identity', async () => {
    const [first, second, replay] = await Effect.runPromise(
      Effect.all([
        executionIntentIdForPlan({ ...input, replanGenerationHash: hash('c') }, hash('a')),
        executionIntentIdForPlan({ ...input, replanGenerationHash: hash('d') }, hash('a')),
        executionIntentIdForPlan({ ...input, replanGenerationHash: hash('c') }, hash('a')),
      ]),
    )

    expect(first).not.toBe(second)
    expect(replay).toBe(first)
  })

  test('refuses to create a durable intent from OBSERVE authority', async () => {
    const result = await Effect.runPromiseExit(planExecutionIntent(input, riskState(hash('c'), Authority.Observe)))

    expect(Exit.isFailure(result)).toBe(true)
  })
})

describe('pure intent commit decisions', () => {
  test('validates exact golden intent and risk identities synchronously', () => {
    const result = validateCommitIdentity(paperIntent, approvedDecision)

    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) {
      expect(result.success).toEqual({ _tag: 'PreparedCommit', intent: paperIntent, decision: approvedDecision })
      expect(result.success.intent.intentId).toBe('6f3b7a528607ed8804f55c5fe23a0c47a4d6f72abf2bb9a41a69d93368d9c8ac')
      expect(result.success.intent.clientOrderId).toBe('b1_bzt6UoYH7YgE9Vxf4joMR6TW9yq_K7mkGmnZM2jZyKw')
      expect(result.success.decision.decisionId).toBe(
        'dfb3ec0a5fda18eb05a9869870039f694c18d3639907963ef26e5a9cafcd50cd',
      )
    }
  })

  test('rejects malformed intent input through the exact decode failure without defecting', () => {
    const result = validateCommitIdentity({ ...paperIntent, strategyName: 'invalid\ud800strategy' }, approvedDecision)

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe('IntentDecodeFailed')
      if (result.failure._tag === 'IntentDecodeFailed') {
        expect(String(result.failure.cause)).toContain('["strategyName"]')
        expect(String(result.failure.cause)).toContain('well-formed Unicode')
      }
    }
  })

  test('totalizes the exported reference identity helper without changing its golden ID', () => {
    const golden = intentIdForPlan(input)
    const invalid = intentIdForPlan({ ...input, strategyName: 'invalid\ud800strategy' })

    expect(golden).toMatchObject({
      _tag: 'Success',
      success: 'bbfe217b000266231ce1c29b8e3d447ad0e60903d287ee3e40a33aa964394fac',
    })
    expect(Result.isFailure(invalid)).toBe(true)
    if (Result.isFailure(invalid)) {
      expect(invalid.failure).toMatchObject({
        _tag: 'CanonicalizationFailed',
        material: { _tag: 'ReferenceIntentIdentity', strategyName: 'invalid\ud800strategy' },
        cause: {
          _tag: 'CanonicalJsonFailure',
          path: '$.strategyName',
          reason: 'invalid-unicode-surrogate',
          actualType: 'string',
        },
      })
    }
  })

  test('classifies insert, incomplete completion, and exact replay without mutation', () => {
    const prepared = preparedCommit()
    const insert = classifyExistingCommit([], prepared)
    const incomplete = classifyExistingCommit([storedIntent(IntentState.Planned, undefined)], prepared)
    const replay = classifyExistingCommit([storedIntent(IntentState.Approved, approvedDecision)], prepared)

    expect(Result.isSuccess(insert) && insert.success._tag).toBe('InsertIntent')
    expect(Result.isSuccess(incomplete) && incomplete.success._tag).toBe('CompleteIntent')
    expect(Result.isSuccess(replay) && replay.success._tag).toBe('ExactReplay')
    if (Result.isSuccess(replay) && replay.success._tag === 'ExactReplay') {
      expect(replay.success.receipt.deduplicated).toBe(true)
      expect(replay.success.receipt.record.intent.state).toBe(IntentState.Approved)
    }
  })

  test('gives immutable conflict precedence over incomplete-state validation', () => {
    const prepared = preparedCommit()
    const result = classifyExistingCommit(
      [
        {
          ...storedIntent(IntentState.Acknowledged, undefined),
          intent: { ...paperIntent, accountId: 'paper-account-2', state: IntentState.Acknowledged },
        },
      ],
      prepared,
    )

    expect(Result.isFailure(result) && result.failure._tag).toBe('ImmutableIntentMismatch')
  })

  test('requires execution maximum and effective authority, a clear kill, and exact generation history', () => {
    const variants = [
      authorityRow({ maximum: Authority.Observe }),
      authorityRow({ effective: Authority.Observe }),
      authorityRow({ kill_state: KillState.Active }),
      authorityRow({ generation_hash: hash('b') }),
      authorityRow({ generation_account_id: 'paper-account-2' }),
      authorityRow({ generation_risk_policy_hash: hash('4') }),
      authorityRow({ generation_strategy_name: 'another-strategy' }),
    ]
    const tags = variants.map((authority) => {
      const result = validateCurrentAuthority([authority], paperIntent)
      return Result.isFailure(result) ? result.failure._tag : 'Success'
    })

    expect(Result.isSuccess(validateCurrentAuthority([authorityRow()], paperIntent))).toBe(true)
    expect(tags).toEqual([
      'MaximumAuthorityNotGranted',
      'EffectiveAuthorityNotGranted',
      'AuthorityKillNotClear',
      'AuthorityGenerationMismatch',
      'AuthorityGenerationHistoryMismatch',
      'AuthorityGenerationHistoryMismatch',
      'AuthorityGenerationHistoryMismatch',
    ])
  })

  test('permits either close side after the kill restricts effective authority', () => {
    for (const side of [OrderSide.Buy, OrderSide.Sell]) {
      expect(
        Result.isSuccess(
          validateCurrentClosingAuthority([authorityRow({ kill_state: KillState.Active })], { ...paperIntent, side }),
        ),
      ).toBe(true)
    }
  })

  test('strictly decodes database rows and rejects excess or malformed fields', () => {
    const stored = decodeStoredIntentRows([storedRow])
    const extraStored = decodeStoredIntentRows([{ ...storedRow, unexpected: true }])
    const malformedStored = decodeStoredIntentRows([{ ...storedRow, state_version: 0 }])
    const authority = decodeAuthorityBindingRows([authorityRow()])
    const extraAuthority = decodeAuthorityBindingRows([{ ...authorityRow(), unexpected: true }])

    expect(Result.isSuccess(stored)).toBe(true)
    expect(Result.isFailure(extraStored)).toBe(true)
    expect(Result.isFailure(malformedStored)).toBe(true)
    expect(Result.isSuccess(authority)).toBe(true)
    expect(Result.isFailure(extraAuthority)).toBe(true)
  })

  test('totalizes insert, decision, and transition RETURNING dispositions', () => {
    expect(decideIntentInsert([], paperIntent.intentId)).toMatchObject({
      _tag: 'Success',
      success: { _tag: 'IntentInsertConflict', intentId: paperIntent.intentId },
    })
    expect(decideIntentInsert([{ intent_id: paperIntent.intentId }], paperIntent.intentId)).toMatchObject({
      _tag: 'Success',
      success: { _tag: 'IntentInserted', intentId: paperIntent.intentId },
    })
    expect(decideRiskCommit([{ decision_id: approvedDecision.decisionId }], approvedDecision.decisionId)).toMatchObject(
      {
        _tag: 'Success',
        success: { _tag: 'RiskDecisionInserted', decisionId: approvedDecision.decisionId },
      },
    )
    expect(decideIntentTransition([{ intent_id: paperIntent.intentId }], paperIntent.intentId)).toMatchObject({
      _tag: 'Success',
      success: { _tag: 'IntentTransitioned', intentId: paperIntent.intentId },
    })
    expect(Result.isFailure(decideRiskCommit([], approvedDecision.decisionId))).toBe(true)
    expect(Result.isFailure(decideIntentTransition([{ intent_id: hash('f') }], paperIntent.intentId))).toBe(true)
    expect(Result.isFailure(decideIntentInsert([{ intent_id: 'invalid' }], paperIntent.intentId))).toBe(true)
  })
})
