import { beforeAll, expect, test } from 'bun:test'
import { Effect, Result } from 'effect'
import { cryptoPersistenceDocumentFixture, persistenceDocumentFixture } from './decision-persistence.test-support'
import { replacementProtectionFixture } from './protection-evidence.test-support'
import type { ExecutionDecisionDocument } from '../shadow-decision-contract'
import { executionOrderPlans } from './execution-plans'
import { bindExecutionEvidence } from './execution-evidence'
import { decisionAdmissionWitnesses } from './decision-admissions'
import { testHash } from './fixtures.test-support'
import { TimeInForce } from '../execution/contracts'
import { capturedAccountsFixture } from './source-cut.test-support'
import { bindSystemSourceCut } from './bind-source'
import { makeExecutionIntentFromDecodedPlan } from '../execution/intents/domain'
import type { IntentPlan } from '../execution/intents/domain'
import type { ProtectionIntentEvidence } from './execution-plans'

let document: ExecutionDecisionDocument
beforeAll(async () => {
  document = await Effect.runPromise(persistenceDocumentFixture)
})

test.each(['Oco', 'StopLimit'] as const)(
  'replacement %s binds its own intent, prices, fills and submission deadline',
  (kind) => {
    const f = replacementProtectionFixture(document, kind)
    const plans = Result.getOrThrow(executionOrderPlans(f.cut.decisions, f.cut.protectionIntents))
    const derived = plans.get(f.evidence.intentId)!
    expect(derived.decisionId).toBe(f.evidence.intentId)
    expect(derived.createdAt).toBe(f.evidence.riskDecision.decidedAt)
    const bound = Result.getOrThrow(bindExecutionEvidence(f.supplied, f.cut, document.bindings.authorityGenerationHash))
    expect(bound.missing).toEqual([])
    expect(bound.fills.at(-1)?.pricing.sourceHash).toBe(f.evidence.sourceHash)
    expect(bound.fills.at(-1)?.submissionDeadlineAt).toBe(f.evidence.riskDecision.expiresAt)
    const admissions = Result.getOrThrow(decisionAdmissionWitnesses(f.cut, document.bindings.authorityGenerationHash))
    expect(
      admissions.witnesses.some((row) => row.sourceHash === f.evidence.intentId && row.witnessedAt === f.at(1002)),
    ).toBe(true)
  },
)

test('replacement evidence rejects substituted identity, risk approval, ownership, prices and reconciliation', () => {
  const f = replacementProtectionFixture(document)
  const evidence = f.evidence
  for (const changed of [
    { ...evidence, intentId: testHash('substitute') },
    { ...evidence, clientOrderId: 'foreign' },
    { ...evidence, authorityGenerationHash: testHash('foreign') },
    { ...evidence, riskDecision: { ...evidence.riskDecision, inputHash: testHash('foreign') } },
    { ...evidence, plan: { ...evidence.plan, accountId: 'foreign' } },
    { ...evidence, plan: { ...evidence.plan, limitPriceMicros: '1' } },
    { ...evidence, plan: { ...evidence.plan, quantityAtoms: '999999999999999999999' } },
    { ...evidence, reconciliation: { ...evidence.reconciliation, contentHash: testHash('foreign') } },
    { ...evidence, reconciliation: { ...evidence.reconciliation, reconciledAt: f.at(2000) } },
  ]) {
    const { sourceHash: _hash, ...material } = changed
    expect(
      Result.isFailure(executionOrderPlans(f.cut.decisions, [{ ...material, sourceHash: testHash(material) }])),
    ).toBe(true)
  }
  expect(Result.isFailure(executionOrderPlans(f.cut.decisions, [evidence, evidence]))).toBe(true)
  expect(Result.isFailure(executionOrderPlans([], [evidence]))).toBe(true)
})

test('rehashing an altered protection plan cannot change the entry ceiling or owner', () => {
  const f = replacementProtectionFixture(document)
  const reseal = (evidence: ProtectionIntentEvidence) => {
    const intent = Result.getOrThrow(
      makeExecutionIntentFromDecodedPlan(evidence.plan, evidence.authorityGenerationHash),
    )
    const { decisionId: _id, ...risk } = { ...evidence.riskDecision, intentId: intent.intentId }
    const material = {
      ...evidence,
      intentId: intent.intentId,
      clientOrderId: intent.clientOrderId,
      riskDecision: { ...risk, decisionId: testHash(risk) },
    }
    const { sourceHash: _source, ...source } = material
    return { ...source, sourceHash: testHash(source) }
  }
  const original = f.evidence
  if (original.plan.protection?._tag !== 'Oco') throw new Error('Expected OCO evidence')
  const price = (BigInt(original.plan.limitPriceMicros!) + 1000000n).toString()
  const protection = { ...original.plan.protection, profitLimitPriceMicros: price }
  const alteredPlans: readonly IntentPlan[] = [
    { ...original.plan, accountId: 'another-account' },
    { ...original.plan, quantityAtoms: (BigInt(f.parent.quantityAtoms!) + 1n).toString() },
    {
      ...original.plan,
      limitPriceMicros: price,
      protection,
      notionalLimitMicros: ((BigInt(original.plan.quantityAtoms) * BigInt(price)) / 1000000000n).toString(),
      replanGenerationHash: testHash({
        entryDecisionHash: document.contentHash,
        reconciliationId: original.reconciliation.reconciliationId,
        protection,
      }),
    },
  ]
  for (const plan of alteredPlans) {
    const altered = reseal({ ...original, plan })
    const result = executionOrderPlans(f.cut.decisions, [altered])
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result) && 'message' in result.failure)
      expect(result.failure.message).toContain('owned entry plan')
  }
  const expired = reseal({ ...original, riskDecision: { ...original.riskDecision, expiresAt: f.at(1000) } })
  expect(Result.isFailure(executionOrderPlans(f.cut.decisions, [expired]))).toBe(true)
  const late = {
    ...f.cut,
    decisionAdmissions: f.cut.decisionAdmissions,
    mutations: f.cut.mutations.map((row) =>
      row.event.eventType === 'SUBMIT_STARTED' ? { ...row, event: { ...row.event, occurredAt: f.at(5001) } } : row,
    ),
  }
  expect(Result.isFailure(decisionAdmissionWitnesses(late, document.bindings.authorityGenerationHash))).toBe(true)
})

test('the assessment consumer derives independent protection decisions and keeps absent admissions incomplete', () => {
  const f = replacementProtectionFixture(document)
  const { input, cut: financialCut, verifiedSources } = capturedAccountsFixture()
  const definition = {
    ...input.registration.policies.find((policy) => policy.policy === 'JEV')!,
    authorityGenerationHash: document.bindings.authorityGenerationHash,
  }
  const registration = {
    ...input.registration,
    policies: input.registration.policies.map((policy) => (policy.policy === 'JEV' ? definition : policy)),
  }
  const cut = {
    ...financialCut,
    registrationHash: testHash(registration),
    decisions: f.cut.decisions,
    protectionIntents: f.cut.protectionIntents,
    decisionAdmissions: f.cut.decisionAdmissions,
    mutations: f.cut.mutations,
    fills: f.cut.fills,
    orders: f.cut.orders,
    financial: financialCut.financial.map((account) =>
      account.policy === 'JEV' ? { ...account, definitionHash: testHash(definition) } : account,
    ),
  }
  const supplied = {
    ...input,
    registration,
    registrationReceiptHash: testHash(registration),
    sourceCutHash: testHash(cut),
    realism: { ...input.realism, fills: f.supplied, expectedDecisionIds: [], expectedFillIds: [], decisions: [] },
  }
  const bound = Result.getOrThrow(bindSystemSourceCut(supplied, cut, verifiedSources))
  expect(bound.input.realism.expectedDecisionIds).toContain(f.evidence.intentId)
  expect(bound.input.realism.expectedDecisionIds).toContain(document.contentHash)
  expect(bound.input.realism.expectedFillIds).toEqual(f.cut.fills.map((fill) => fill.fillId))
  const derived = bound.input.realism.decisions.find((row) => row.decisionId === f.evidence.intentId)!
  expect(derived.persistedAt).toBe(f.at(1002))
  expect(derived.inputs.map((row) => row.contentHash)).toContain(f.evidence.reconciliation.contentHash)
  // Submitted derived facts are replaced from the captured approval instead of being appended twice.
  const repeated = Result.getOrThrow(
    bindSystemSourceCut(
      { ...supplied, realism: { ...supplied.realism, decisions: [{ ...derived, decisionAt: f.at(9999) }] } },
      cut,
      verifiedSources,
    ),
  )
  expect(repeated.input.realism.decisions).toEqual([derived])
  const missing = { ...cut, decisionAdmissions: [] }
  const incomplete = Result.getOrThrow(
    bindSystemSourceCut({ ...supplied, sourceCutHash: testHash(missing) }, missing, verifiedSources),
  )
  expect(incomplete.input.realism.unsupportedAssumptions).toContain(
    `MISSING_PROTECTION_INTENT_PERSISTENCE:${f.evidence.intentId}`,
  )
  expect(
    Result.isFailure(
      bindSystemSourceCut(
        { ...supplied, sourceCutHash: testHash({ ...cut, protectionIntents: [] }) },
        { ...cut, protectionIntents: [] },
        verifiedSources,
      ),
    ),
  ).toBe(true)
})

test('all replacement groups share entry inventory and missing actual fill evidence remains incomplete', () => {
  const f = replacementProtectionFixture(document)
  const missing = Result.getOrThrow(
    bindExecutionEvidence(f.supplied.slice(1), f.cut, document.bindings.authorityGenerationHash),
  )
  expect(missing.missing.some((reason) => reason.startsWith('MISSING_ACTUAL_FILL'))).toBe(true)
  const last = f.cut.fills.at(-1)!
  const changed = { ...last, quantityAtoms: (BigInt(last.quantityAtoms) + 1n).toString() }
  const fills = f.cut.fills.map((fill) => (fill.fillId === last.fillId ? changed : fill))
  const supplied = f.supplied.map((fill) =>
    fill.fillId === last.fillId ? { ...fill, fillQuantityAtoms: changed.quantityAtoms } : fill,
  )
  expect(
    Result.isFailure(bindExecutionEvidence(supplied, { ...f.cut, fills }, document.bindings.authorityGenerationHash)),
  ).toBe(true)
})

test('a fractional crypto standalone stop binds GTC terms and its own risk and admission evidence', async () => {
  const crypto = await Effect.runPromise(cryptoPersistenceDocumentFixture)
  expect(crypto.dispatchable).toBe(true)
  const f = replacementProtectionFixture(crypto, 'StopLimit')
  expect(f.parent.symbol).toBe('BTC/USD')
  expect(f.parent.timeInForce).toBe(TimeInForce.GoodUntilCanceled)
  expect(BigInt(f.parent.quantityAtoms!) % 1000000000n).not.toBe(0n)
  const bound = Result.getOrThrow(bindExecutionEvidence(f.supplied, f.cut, crypto.bindings.authorityGenerationHash))
  expect(bound.missing).toEqual([])
  expect(bound.fills.at(-1)?.pricing._tag).toBe('NativeProtection')
  expect(bound.fills.at(-1)?.expiresAt).toBe(f.at(8000))
  const admissions = Result.getOrThrow(decisionAdmissionWitnesses(f.cut, crypto.bindings.authorityGenerationHash))
  expect(admissions.witnesses.some((row) => row.sourceHash === f.evidence.intentId)).toBe(true)
})
