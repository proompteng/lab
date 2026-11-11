import { beforeAll, describe, expect, test } from 'bun:test'
import { sha256 } from '../hash'
import { Effect, Result, Schema } from 'effect'

import { nativeJevFixture, nativeJevDecisionEvidence } from '../jev/native.test-support'
import { matchedCommittedDecisionFixture } from '../intraday-replay/matched-entry.test-support'
import type { ExecutionDecisionDocument } from '../shadow-decision-contract'
import {
  ControllerPassEvidenceSchema,
  decisionDocumentWork,
  entryAbstentionWork,
  holdCompletionSupported,
  accountProtectionWork,
  decisionMarketScopeSupported,
  sourceFitsRegisteredSession,
} from './decision-work'
import { decideJevEntry } from '../jev/decision'
import { registrationFixture, testHash } from './fixtures.test-support'
import { makeBrokerIdentity, BrokerEnvironment, BrokerProvider } from '../broker/identity'
import { RetainedAutonomousCyclePassObservationSchema } from '../cycle/runner/pass-observation'
import { qualificationCalendar } from './calendar'
import { MarketCalendarObservationSchema } from '../broker/alpaca/model'
import type { SystemRegistration } from './policy'
import { accountProtectionFixture } from '../jev/account-protection.test-support'
import { AccountProtectionInputsSchema, decideAccountProtection } from '../jev/account-protection'
import { retainAutonomousCyclePassObservation, cyclePassLogFacts } from '../cycle/runner/pass-decisions'
import { DecisionReadinessReason } from '../cycle/runner/readiness'

let document: ExecutionDecisionDocument
let scopedRegistration: SystemRegistration
beforeAll(async () => {
  const native = nativeJevFixture()
  document = await Effect.runPromise(matchedCommittedDecisionFixture(native, nativeJevDecisionEvidence(native)))
  const base = registrationFixture()
  scopedRegistration = {
    ...base,
    calendar: {
      ...base.calendar,
      sessions: Result.getOrThrow(qualificationCalendar(native.snapshot.manifest.calendar)).sessions,
    },
  }
})

describe('strategy decision work evidence', () => {
  test('account-limit abstention reproduces the actual risk decision and keeps its private inputs out of logs', async () => {
    const { native, policy, decision, inputs } = await accountProtectionFixture()
    expect(Schema.is(AccountProtectionInputsSchema)(inputs)).toBe(true)
    const identity = Result.getOrThrow(
      makeBrokerIdentity({
        schemaVersion: 'bayn.broker-identity.v2',
        provider: BrokerProvider.Alpaca,
        environment: BrokerEnvironment.Sandbox,
        accountId: policy.accountId,
      }),
    )
    const registration = {
      ...scopedRegistration,
      policies: scopedRegistration.policies.map((p) =>
        p.policy === 'JEV'
          ? {
              ...p,
              accountBindingHash: testHash({
                schemaVersion: 'bayn.inference-cost-account.v1',
                accountId: policy.accountId,
              }),
              authorityGenerationHash: native.input.authorityGenerationHash,
              riskPolicyHash: testHash(policy),
              riskPolicy: policy,
              protocolHash: native.draft.identity.strategyProtocolHash,
            }
          : p,
      ),
    }
    const completedAt = new Date(Date.parse(decision.observedAt) + 1).toISOString()
    const passObservation = { outcome: 'SUCCEEDED' as const, observedAt: completedAt, result: decision }
    const pass = Schema.decodeUnknownSync(ControllerPassEvidenceSchema)({
      controllerKey: identity.identityHash,
      planHash: registration.obligations.configuration.controllerPlanHash,
      epoch: 1,
      sequence: 1,
      receiptHash: testHash(decision),
      completedAt,
      observation: {
        ...retainAutonomousCyclePassObservation(passObservation),
        executionBuild: {
          sourceRevision: 'a'.repeat(40),
          imageRepository: 'registry.example.test/lab/bayn',
          imageDigest: `sha256:${sha256('image')}`,
        },
      },
    })
    expect(Result.getOrThrow(accountProtectionWork(pass, registration, completedAt))?.correct).toBe(true)
    const { executionBuild, ...unboundObservation } = pass.observation
    for (const build of [
      undefined,
      { ...executionBuild, sourceRevision: 'b'.repeat(40) },
      { ...executionBuild, imageDigest: `sha256:${'2'.repeat(64)}` },
    ]) {
      const changed = Schema.decodeUnknownSync(ControllerPassEvidenceSchema)({
        ...pass,
        observation: { ...unboundObservation, ...(build === undefined ? {} : { executionBuild: build }) },
      })
      expect(Result.getOrThrow(accountProtectionWork(changed, registration, completedAt))?.correct).toBe(false)
    }
    expect(
      Result.getOrThrow(accountProtectionWork(pass, registration, decision.admissionProtection.validUntil))?.correct,
    ).toBe(false)
    const retained = pass.observation
    if (retained.result !== 'SUCCESS') throw new Error('Expected successful wait')
    const { inputs: _inputs, ...historical } = decision.admissionProtection
    expect(
      Result.getOrThrow(
        accountProtectionWork(
          {
            ...pass,
            observation: {
              ...retained,
              admissionProtection: historical,
            },
          },
          registration,
          completedAt,
        ),
      ),
    ).toBeUndefined()
    const differentPolicy = {
      ...registration,
      policies: registration.policies.map((p) => ({ ...p, riskPolicyHash: testHash('other limits') })),
    }
    expect(Result.getOrThrow(accountProtectionWork(pass, differentPolicy, completedAt))?.correct).toBe(false)
    expect(
      Result.getOrThrow(
        accountProtectionWork({ ...pass, controllerKey: testHash('another controller') }, registration, completedAt),
      )?.correct,
    ).toBe(false)
    const atLimit = {
      ...inputs,
      peakEquityMicros: (
        BigInt(inputs.portfolio.brokerState.account.equityMicros) + BigInt(policy.maxDrawdownMicros)
      ).toString(),
    }
    expect(decideAccountProtection(atLimit, native.input.authorityGenerationHash)).toBeUndefined()
    expect(
      Result.getOrThrow(
        accountProtectionWork(
          {
            ...pass,
            observation: {
              ...retained,
              admissionProtection: { ...decision.admissionProtection, inputs: atLimit },
            },
          },
          registration,
          completedAt,
        ),
      )?.correct,
    ).toBe(false)
    if (inputs.schemaVersion !== 'bayn.account-protection-inputs.v2') throw new Error('Expected current inputs')
    const turnoverInputs = {
      ...inputs,
      peakEquityMicros: inputs.portfolio.brokerState.account.equityMicros,
      dailyTradedNotionalMicros: policy.maxDailyTradedNotionalMicros,
    }
    const turnoverPass = Schema.decodeUnknownSync(ControllerPassEvidenceSchema)({
      ...pass,
      observation: {
        ...retained,
        readiness: { reason: DecisionReadinessReason.TurnoverBudgetExhausted, message: 'Daily turnover exhausted' },
        admissionProtection: { ...decision.admissionProtection, inputs: turnoverInputs },
      },
    })
    expect(Result.getOrThrow(accountProtectionWork(turnoverPass, registration, completedAt))?.correct).toBe(true)
    expect(
      Result.getOrThrow(
        accountProtectionWork(
          {
            ...turnoverPass,
            observation: {
              ...retained,
              admissionProtection: { ...decision.admissionProtection, inputs: turnoverInputs },
            },
          },
          registration,
          completedAt,
        ),
      )?.correct,
    ).toBe(false)
    expect(
      decideAccountProtection(
        { ...turnoverInputs, dailyTradedNotionalMicros: (BigInt(policy.maxDailyTradedNotionalMicros) - 1n).toString() },
        native.input.authorityGenerationHash,
      ),
    ).toBeUndefined()
    const { dailyTradedNotionalMicros: _turnover, ...legacyFields } = inputs
    const legacyInputs = { ...legacyFields, schemaVersion: 'bayn.account-protection-inputs.v1' as const }
    expect(Schema.is(AccountProtectionInputsSchema)(legacyInputs)).toBe(true)
    expect(
      Result.getOrThrow(
        accountProtectionWork(
          {
            ...pass,
            observation: {
              ...retained,
              admissionProtection: { ...decision.admissionProtection, inputs: legacyInputs },
            },
          },
          registration,
          completedAt,
        ),
      )?.correct,
    ).toBe(true)
    expect(JSON.stringify(cyclePassLogFacts(passObservation))).not.toContain('peakEquityMicros')
    expect(JSON.stringify(cyclePassLogFacts(passObservation))).not.toContain('dailyTradedNotionalMicros')
    expect(JSON.stringify(cyclePassLogFacts(passObservation))).not.toContain(policy.accountId)
  })
  test('only a reproduced zero-entry decision with complete inputs can establish an abstention', () => {
    const native = nativeJevFixture()
    const target = Result.getOrThrow(decideJevEntry(nativeJevDecisionEvidence(native, false)))
    expect(target.selectedSymbols).toEqual([])
    const accountId = target.evidence.observation.portfolio.brokerState.account.accountId
    const identity = Result.getOrThrow(
      makeBrokerIdentity({
        schemaVersion: 'bayn.broker-identity.v2',
        provider: BrokerProvider.Alpaca,
        environment: BrokerEnvironment.Sandbox,
        accountId,
      }),
    )
    const base = scopedRegistration
    const registration = {
      ...base,
      policies: base.policies.map((p) =>
        p.policy === 'JEV'
          ? {
              ...p,
              accountBindingHash: testHash({ schemaVersion: 'bayn.inference-cost-account.v1', accountId }),
              authorityGenerationHash: target.evidence.observation.authorityGenerationHash,
              protocolHash: document.bindings.strategyProtocolHash,
            }
          : p,
      ),
    }
    const pass = Schema.decodeUnknownSync(ControllerPassEvidenceSchema)({
      controllerKey: identity.identityHash,
      planHash: base.obligations.configuration.controllerPlanHash,
      epoch: 1,
      sequence: 1,
      receiptHash: testHash('abstention receipt'),
      completedAt: target.evidence.decidedAt,
      observation: {
        result: 'SUCCESS',
        outcome: 'RECOVERED',
        recoveryAction: 'WAITING',
        observedAt: target.evidence.decidedAt,
        entryAbstention: target,
        executionBuild: {
          sourceRevision: 'a'.repeat(40),
          imageRepository: 'registry.example.test/lab/bayn',
          imageDigest: `sha256:${sha256('image')}`,
        },
        readiness: { reason: 'NO_ELIGIBLE_CANDIDATE', message: 'No supported entries' },
      },
    })
    expect(Result.getOrThrow(entryAbstentionWork(pass, registration, pass.completedAt))?.correct).toBe(true)
    expect(
      Result.getOrThrow(entryAbstentionWork(pass, registration, target.evidence.batchPlan.expiresAt))?.correct,
    ).toBe(false)
    expect(
      Result.getOrThrow(
        entryAbstentionWork({ ...pass, controllerKey: testHash('foreign') }, registration, pass.completedAt),
      )?.correct,
    ).toBe(false)
    expect(
      Schema.is(RetainedAutonomousCyclePassObservationSchema)({
        ...pass.observation,
        readiness: { reason: 'INFERENCE_UNAVAILABLE', message: 'Unavailable' },
      }),
    ).toBe(false)
    expect(
      Schema.is(RetainedAutonomousCyclePassObservationSchema)({
        ...pass.observation,
        entryAbstention: Result.getOrThrow(decideJevEntry(nativeJevDecisionEvidence(native))),
      }),
    ).toBe(false)
  })
  test('late completion remains attached to its original native signal window', () => {
    const work = decisionDocumentWork(document, scopedRegistration)
    expect(work?.correct).toBe(true)
    const strategy = document.strategyDecision
    if (strategy?.schemaVersion !== 'bayn.jev-entry-target.v7') throw new Error('Missing native decision')
    const manifest = strategy.evidence.observation.manifest
    expect(work?.sourceAt).toBe(new Date(Date.parse(String(manifest['rangeEndAt'])) + 2000).toISOString())
    const late = { ...document, createdAt: new Date(Date.parse(document.createdAt) + 120000).toISOString() }
    expect(decisionDocumentWork(late, scopedRegistration)).toEqual(work)
    expect(decisionDocumentWork(document, registrationFixture())?.correct).toBe(false)
    const without = { ...document }
    delete without.strategyDecision
    expect(decisionDocumentWork(without, scopedRegistration)).toBeUndefined()
  })
  test('retains same-session decision context without counting work outside the registered period', () => {
    const binding = document.bindings.executionMarketData
    if (binding === undefined || !('feed' in binding)) throw new Error('Missing native snapshot binding')
    const observedAt = Date.parse(binding.observedAt)
    for (const [open, close] of [
      [observedAt + 60_000, observedAt + 120_000],
      [observedAt - 120_000, observedAt - 60_000],
    ] as const) {
      const registration = {
        ...scopedRegistration,
        calendar: {
          ...scopedRegistration.calendar,
          operatingHours: 'NATIVE' as const,
          marketCalendar: Schema.decodeUnknownSync(MarketCalendarObservationSchema)(binding.calendar),
          sessions: scopedRegistration.calendar.sessions.map((s) => ({
            ...s,
            openAt: new Date(open).toISOString(),
            closeAt: new Date(close).toISOString(),
          })),
        },
      }
      expect(sourceFitsRegisteredSession(binding, registration, binding.observedAt)).toBe(false)
      expect(decisionDocumentWork(document, registration)?.correct).toBe(false)
      expect(decisionMarketScopeSupported(document, registration)).toBe(true)
      for (const changed of [
        { ...binding, feed: 'sip' },
        { ...binding, universeSymbolHash: testHash('foreign universe') },
        { ...binding, sessionDate: '2026-11-01' },
      ] as const)
        expect(
          decisionMarketScopeSupported(
            { ...document, bindings: { ...document.bindings, executionMarketData: changed } },
            registration,
          ),
        ).toBe(false)
    }
  })
  test('a hold needs ordered observation, completion and durable visibility strictly before expiry', () => {
    const instant = (n: number) => new Date(n).toISOString()
    const valid = {
      observedAt: instant(1),
      passObservedAt: instant(2),
      completedAt: instant(3),
      witnessedAt: instant(4),
      validUntil: instant(5),
    }
    expect(holdCompletionSupported(valid)).toBe(true)
    for (const change of [
      { passObservedAt: instant(0) },
      { completedAt: instant(1) },
      { witnessedAt: instant(2) },
      { witnessedAt: instant(5) },
      { validUntil: instant(4) },
    ])
      expect(holdCompletionSupported({ ...valid, ...change })).toBe(false)
  })
})
