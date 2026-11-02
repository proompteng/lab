import { canonicalHashV1Result } from '../hash'
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
} from './intents/domain'

const hash = (digit: string): string => digit.repeat(64)

const input: IntentPlan = {
  schemaVersion: 'bayn.intent-plan.v3',
  strategyName: 'risk-balanced-trend',
  cycleId: hash('1'),
  decisionHash: hash('2'),
  policyHash: hash('3'),
  accountId: 'paper-account-1',
  symbol: 'NVDA',
  side: OrderSide.Buy,
  orderType: OrderType.Limit,
  timeInForce: TimeInForce.Day,
  quantityAtoms: '1000000000',
  notionalLimitMicros: '200000000',
  limitPriceMicros: '200000000',
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
  schemaVersion: 'bayn.execution-intent.v5',
  authorityGenerationHash: hash('a'),
  intentId: 'df59c104e41085f3213adc39de60c4a66bd5fb602e05a28e951e4bb20f2875b8',
  strategyName: input.strategyName,
  cycleId: input.cycleId,
  decisionHash: input.decisionHash,
  policyHash: input.policyHash,
  accountId: input.accountId,
  clientOrderId: 'b1_31nBBOQQhfMhOtw53mDEpmvV-2AuBaKOlR5Lsg8odbg',
  symbol: input.symbol,
  side: input.side,
  orderType: input.orderType,
  timeInForce: input.timeInForce,
  quantityAtoms: input.quantityAtoms,
  notionalLimitMicros: input.notionalLimitMicros,
  limitPriceMicros: input.limitPriceMicros,
  state: IntentState.Planned,
  createdAt: input.createdAt,
}

const approvedDecision: RiskDecision = {
  schemaVersion: 'bayn.paper-risk-decision.v1',
  decisionId: '49382df77419307b1bd14aaef003ba8e32453a5e0b92b064f5dacd10cc949ddd',
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
  quantity_atoms: paperIntent.quantityAtoms,
  notional_limit_micros: paperIntent.notionalLimitMicros,
  limit_price_micros: paperIntent.limitPriceMicros,
  replan_generation_hash: null,
  protection: null,
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
    expect(first.schemaVersion).toBe('bayn.reference-intent.v4')
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
      { ...input, limitPriceMicros: '201000000', notionalLimitMicros: '201000000' },
      { ...input, quantityAtoms: '2000000000', notionalLimitMicros: '400000000' },
      { ...input, notionalLimitMicros: '300000000', limitPriceMicros: '300000000' },
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
      plan({ ...input, cycleId: 'not-a-hash', quantityAtoms: '0', extra: true }),
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
      schemaVersion: 'bayn.execution-intent.v5',
      authorityGenerationHash: hash('a'),
      state: IntentState.Planned,
    })
    expect(rotated.authorityGenerationHash).toBe(hash('b'))
    expect(rotated.intentId).not.toBe(first.intentId)
    expect(rotated.clientOrderId).not.toBe(first.clientOrderId)
  })

  test('derives the v4 identity without authority state and rejects malformed material', async () => {
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
      expect(result.success.intent.intentId).toBe('df59c104e41085f3213adc39de60c4a66bd5fb602e05a28e951e4bb20f2875b8')
      expect(result.success.intent.clientOrderId).toBe('b1_31nBBOQQhfMhOtw53mDEpmvV-2AuBaKOlR5Lsg8odbg')
      expect(result.success.decision.decisionId).toBe(
        '49382df77419307b1bd14aaef003ba8e32453a5e0b92b064f5dacd10cc949ddd',
      )
    }
  })

  test('native strategy prices survive construction, immutable identity and commit verification', async () => {
    const intent = await Effect.runPromise(
      planExecutionIntent(
        {
          ...input,
          protection: {
            _tag: 'Bracket',
            stopPriceMicros: '198000000',
            stopLimitPriceMicros: '197800000',
            profitLimitPriceMicros: '203000000',
          },
        },
        riskState(),
      ),
    )
    const { decisionId: _decisionId, ...material } = { ...approvedDecision, intentId: intent.intentId }
    const decision = { ...material, decisionId: Result.getOrThrow(canonicalHashV1Result(material)) }
    const prepared = validateCommitIdentity(intent, decision)
    expect(Result.isSuccess(prepared)).toBe(true)
    expect(
      Result.isFailure(
        validateCommitIdentity(
          { ...intent, protection: { ...intent.protection, stopPriceMicros: '197990000' } },
          decision,
        ),
      ),
    ).toBe(true)
    if (Result.isFailure(prepared)) throw new Error('Native commit must preserve the strategy terms')
    const changed: StoredIntent = {
      intent: {
        ...intent,
        protection: {
          _tag: 'Bracket',
          stopPriceMicros: '197990000',
          stopLimitPriceMicros: '197800000',
          profitLimitPriceMicros: '203000000',
        },
        state: IntentState.Planned,
      },
      stateVersion: 1,
      updatedAt: intent.createdAt,
    }
    expect(Result.isFailure(classifyExistingCommit([changed], prepared.success))).toBe(true)
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

  test('totalizes the exported reference identity helper with its explicit-price golden ID', () => {
    const golden = intentIdForPlan(input)
    const invalid = intentIdForPlan({ ...input, strategyName: 'invalid\ud800strategy' })

    expect(golden).toMatchObject({
      _tag: 'Success',
      success: 'e38cf5c95605dd243d7ec5989a12841ee84cc55e32b2b058c701460671b2dd49',
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
