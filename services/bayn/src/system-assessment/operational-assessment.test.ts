import { JevResearchPolicy } from '../jev/acceptance'
import { expect, test } from 'bun:test'
import { Effect, Result, Schema } from 'effect'
import { PgClient } from '@effect/sql-pg'
import { operationalRegistrationFixture } from './operational-period.test-support'
import {
  makeOperationalSafetyAudit,
  operationalAssessmentVerdict,
  verifyStoredOperationalAssessment,
  evaluateOperationalAssessment,
} from './operational-assessment'
import { emptySourceCutFixture } from './source-cut.test-support'
import { SystemSourceCutSchema } from './source-cut'
import { testHash } from './fixtures.test-support'
import { SafetyViolationKind } from './assessment'
import { ObligationClass, ReliabilityStatus } from './reliability'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import { ControllerPassEvidenceSchema } from './decision-work'
import { registeredSchedule } from './schedule'
import { makeCycleExecutionPolicyFromModel } from '../cycle/construction'
import { MutationEventSchema } from '../execution/mutations/model'
import { qualificationDeadlines } from './configuration'
import { canonicalJsonV1Result, sha256 } from '../hash'
import {
  OperationalSourceCutSchema,
  isVerifiedOperationalSourceCut,
  readOperationalAssessmentSourceCut,
} from './operational-source-cut'
import { makeSystemSourceRecord, SystemSourceRecordKind } from './source-records'

const fixture = (controllerPlanHash?: string | null) => {
  const baseRegistration = operationalRegistrationFixture()
  const configuration = {
    ...baseRegistration.obligations.configuration,
    ...(controllerPlanHash === undefined ? {} : { controllerPlanHash }),
  }
  const registration = {
    ...baseRegistration,
    obligations: {
      ...baseRegistration.obligations,
      configuration,
      ...Result.getOrThrow(qualificationDeadlines(configuration)),
    },
  }
  const { cut: base } = emptySourceCutFixture()
  const cut = Schema.decodeUnknownSync(SystemSourceCutSchema)({
    ...base,
    registrationHash: testHash(registration),
    asOf: registration.calendar.sessions[0]!.openAt,
    runtimeConfigurationHash: registration.obligations.runtimeConfigurationHash,
    financial: [],
  })
  const input = {
    schemaVersion: 'bayn.operational-assessment-input.v2',
    registration,
    sourceCutHash: testHash(cut),
    safety: Result.getOrThrow(
      makeOperationalSafetyAudit({
        schemaVersion: 'bayn.operational-safety-audit.v1',
        coverage: 'COMPLETE',
        auditEvidenceHash: testHash('complete safety scan evidence'),
        registrationHash: cut.registrationHash,
        asOf: cut.asOf,
        violations: [],
      }),
    ),
  }
  const verified = new Set([
    registration.calendar.sourceHash,
    ...registration.retainedIncidentSources,
    input.safety.sourceHash,
    input.safety.auditEvidenceHash,
  ])
  return { cut, input, verified }
}

test('an open operating period and missing accounting cannot become a reliability certificate', () => {
  const { cut, input, verified } = fixture()
  const result = Result.getOrThrow(verifyStoredOperationalAssessment(input, cut, verified))
  expect(result.verdict).toBe('INCONCLUSIVE')
  expect(result.economicQualification).toBe('NOT_ASSESSED')
  expect(result.safety.pass).toBe(true)
  expect(result.missing).toContain('OPEN_REPORTING_PERIOD')
  expect(result.missing).toContain('INCOMPLETE_FILL_ACCOUNTING')
  expect(result.reliability.classes.find((row) => row.class === ObligationClass.Mutation)?.status).toBe(
    ReliabilityStatus.Undetermined,
  )
  expect(result.reliability.classes.find((row) => row.class === ObligationClass.Recovery)?.status).toBe(
    ReliabilityStatus.Undetermined,
  )
  expect(result.missing).toContain('INCOMPLETE_MUTATION_SOURCE_COVERAGE')
  expect(
    Result.isFailure(
      verifyStoredOperationalAssessment({ ...input, reliability: { good: 1000, scheduled: 1000 } }, cut, verified),
    ),
  ).toBe(true)
})

test('scheduled work that never starts stays in the closed period denominator', () => {
  const { cut: original, input, verified } = fixture()
  const asOf = '2026-11-04T00:03:00.000Z'
  const cut = { ...original, asOf }
  const result = Result.getOrThrow(
    verifyStoredOperationalAssessment(
      { ...input, sourceCutHash: testHash(cut), safety: { ...input.safety, asOf } },
      cut,
      verified,
    ),
  )
  expect(result.verdict).toBe('REJECTED')
  const decisions = result.reliability.classes.find((row) => row.class === ObligationClass.Decision)!
  expect(decisions.scheduled).toBe('2')
  expect(decisions.correctOnTime).toBe('0')
  expect(decisions.missed).toHaveLength(2)
})

test('a retained null controller plan cannot certify current operational reliability or alter v1 replay', () => {
  const { cut, input, verified } = fixture(null)
  expect(input.registration.obligations.configuration.controllerPlanHash).toBeNull()
  expect(input.registration.obligations.configuration.entryMarkets).toBeDefined()
  expect(cut.controllerPasses).toEqual([])
  const sourceCutHash = testHash(cut)
  const historicalInput = { ...input, schemaVersion: 'bayn.operational-assessment-input.v1' }
  const historical = Result.getOrThrow(verifyStoredOperationalAssessment(historicalInput, cut, verified))
  const current = Result.getOrThrow(verifyStoredOperationalAssessment(input, cut, verified))
  expect(current.missing).toContain('UNBOUND_CONTROLLER_PLAN')
  expect(historical.missing).not.toContain('UNBOUND_CONTROLLER_PLAN')
  expect(historical).not.toHaveProperty('evaluationPolicy')
  expect(current.reliability).toEqual(historical.reliability)
  const { evaluationPolicy: _policy, ...material } = current
  expect(historical).toEqual({
    ...material,
    missing: current.missing.filter((reason) => reason !== 'UNBOUND_CONTROLLER_PLAN'),
  })
  expect(testHash(cut)).toBe(sourceCutHash)
  expect(Result.isFailure(evaluateOperationalAssessment(historicalInput, cut, verified))).toBe(true)
  // Even complete independent witnesses and a clean safety audit cannot remove this provenance gate.
  const planMissing = current.missing.filter((reason) => reason === 'UNBOUND_CONTROLLER_PLAN').length
  expect(operationalAssessmentVerdict(ReliabilityStatus.MeetsTarget, planMissing, true, 0)).toBe('INCONCLUSIVE')
})

test('an empty recovery class is inapplicable only when its complete captured mutation scope is available', () => {
  const { cut: original, input, verified } = fixture()
  const identity = Result.getOrThrow(
    makeBrokerIdentity({
      schemaVersion: 'bayn.broker-identity.v2',
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      accountId: input.registration.policies[0].riskPolicy.accountId,
    }),
  )
  const sourceMaterial = {
    mutations: [],
    accounts: [{ policy: 'JEV', identity, forward: { unresolvedMutationCount: 0 } }],
  }
  const cut = { ...original, sourceMaterial, sourceMaterialHash: testHash(sourceMaterial) }
  const result = Result.getOrThrow(
    verifyStoredOperationalAssessment({ ...input, sourceCutHash: testHash(cut) }, cut, verified),
  )
  expect(result.reliability.classes.find((row) => row.class === ObligationClass.Recovery)?.status).toBe(
    ReliabilityStatus.NotApplicable,
  )
  expect(result.verdict).toBe('INCONCLUSIVE')
  const changedMaterial = {
    ...sourceMaterial,
    accounts: [{ ...sourceMaterial.accounts[0]!, forward: { unresolvedMutationCount: 1 } }],
  }
  const changed = { ...cut, sourceMaterial: changedMaterial, sourceMaterialHash: testHash(changedMaterial) }
  expect(
    Result.getOrThrow(
      verifyStoredOperationalAssessment({ ...input, sourceCutHash: testHash(changed) }, changed, verified),
    ).missing,
  ).toContain('UNRESOLVED_ACCOUNT_MUTATION')
})

test('a safety violation rejects the operating claim and scope substitutions fail decoding', () => {
  const { cut, input, verified } = fixture()
  const unsafe = {
    ...input,
    safety: {
      ...input.safety,
      violations: [
        { kind: SafetyViolationKind.Unauthorized, sourceHash: input.safety.sourceHash, occurredAt: cut.asOf },
      ],
    },
  }
  expect(Result.getOrThrow(verifyStoredOperationalAssessment(unsafe, cut, verified)).verdict).toBe('REJECTED')
  expect(
    Result.isFailure(
      verifyStoredOperationalAssessment(input, { ...cut, registrationHash: testHash('another period') }, verified),
    ),
  ).toBe(true)
  const foreign = { ...cut, financial: [{ ...originalFinancial(), policy: JevResearchPolicy.Candidate }] }
  expect(
    Result.isFailure(
      verifyStoredOperationalAssessment({ ...input, sourceCutHash: testHash(foreign) }, foreign, verified),
    ),
  ).toBe(true)
})

const originalFinancial = () => emptySourceCutFixture().cut.financial[0]!

test('each in-period controller pass must bind the registered build even without a completion witness', () => {
  const { cut: original, input, verified } = fixture()
  const candidate = input.registration.policies[0]
  const build = {
    sourceRevision: candidate.sourceRevision,
    imageRepository: candidate.capitalAuthorization!.buildLineage.activation.imageRepository,
    imageDigest: `sha256:${candidate.imageDigest}`,
  }
  const evaluate = (executionBuild: typeof build | undefined) => {
    const observation = {
      result: 'SUCCESS',
      outcome: 'WINDOW_CLOSED',
      observedAt: original.asOf,
      ...(executionBuild === undefined ? {} : { executionBuild }),
    }
    const pass = Schema.decodeUnknownSync(ControllerPassEvidenceSchema)({
      controllerKey: candidate.capitalAuthorization!.request.broker.identityHash,
      planHash: input.registration.obligations.configuration.controllerPlanHash,
      epoch: 1,
      sequence: 1,
      receiptHash: testHash(observation),
      completedAt: original.asOf,
      observation,
    })

    const cut = { ...original, controllerPasses: [pass] }
    const retainedHash = testHash(cut)
    const result = Result.getOrThrow(
      verifyStoredOperationalAssessment({ ...input, sourceCutHash: retainedHash }, cut, verified),
    )
    expect(testHash(cut)).toBe(retainedHash)
    const retainedInput = {
      ...input,
      schemaVersion: 'bayn.operational-assessment-input.v1',
      sourceCutHash: retainedHash,
    }
    expect(Result.isFailure(evaluateOperationalAssessment(retainedInput, cut, verified))).toBe(true)
    const historical = Result.getOrThrow(verifyStoredOperationalAssessment(retainedInput, cut, verified))
    const { evaluationPolicy: _policy, ...currentMaterial } = result
    expect(historical).toEqual({
      ...currentMaterial,
      missing: currentMaterial.missing.filter((reason) => !reason.startsWith('UNBOUND_CONTROLLER_BUILD:')),
    })
    expect(historical).not.toHaveProperty('evaluationPolicy')
    expect(result.evaluationPolicy).toBe('bayn.operational-build-binding.v1')
    return { pass, result }
  }
  const matched = evaluate(build).result
  expect(matched.missing.some((reason) => reason.startsWith('UNBOUND_CONTROLLER_BUILD:'))).toBe(false)
  for (const executionBuild of [
    undefined,
    { ...build, sourceRevision: 'b'.repeat(40) },
    { ...build, imageDigest: `sha256:${testHash('different worker image')}` },
  ]) {
    const { pass, result } = evaluate(executionBuild)
    expect(result.missing).toContain(`UNBOUND_CONTROLLER_BUILD:${pass.receiptHash}`)
    expect(result.reliability).toEqual(matched.reliability)
    expect(result.economicQualification).toBe('NOT_ASSESSED')
    expect(result.verdict).not.toBe('OPERATIONALLY_RELIABLE_PAPER')
  }
})

const completeFixture = () => {
  // Pin the original registration material independently of the current admission fixture.
  const { cut: original, input } = fixture(sha256('controller plan'))
  const registration = input.registration
  const candidate = registration.policies[0]
  const build = candidate.capitalAuthorization!.buildLineage.activation
  const identity = Result.getOrThrow(
    makeBrokerIdentity({
      schemaVersion: 'bayn.broker-identity.v2',
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      accountId: candidate.riskPolicy.accountId,
    }),
  )
  const at = (source: string, offset: number) => new Date(Date.parse(source) + offset).toISOString()
  const asOf = '2026-11-04T00:03:00.000Z'
  const schedule = Result.getOrThrow(registeredSchedule(registration))
  const passes = schedule
    .filter((row) => row.class === ObligationClass.Decision)
    .map((row, index) => {
      const observation = {
        result: 'SUCCESS',
        outcome: 'WINDOW_CLOSED',
        executionIssuedAt: row.dueAt,
        executionBuild: build,
        observedAt: at(row.dueAt, 3),
        closedEntryWindow: {
          schemaVersion: 'bayn.closed-entry-window.v1',
          accountId: identity.accountId,
          authorityGenerationHash: candidate.authorityGenerationHash,
          strategyProtocolHash: candidate.protocolHash,
          executionPolicy: Result.getOrThrow(
            makeCycleExecutionPolicyFromModel(registration.obligations.configuration.protocol.executionModel),
          ),
          evaluatedAt: row.dueAt,
          decidedAt: at(row.dueAt, 2),
          calendar: registration.calendar.marketCalendar,
          calendarRead: {
            requestId: `calendar-${index}`,
            status: 200,
            contentHash: testHash(`calendar-${index}`),
            observedAt: at(row.dueAt, 1),
          },
        },
      }
      return Schema.decodeUnknownSync(ControllerPassEvidenceSchema)({
        controllerKey: identity.identityHash,
        planHash: registration.obligations.configuration.controllerPlanHash,
        epoch: 1,
        sequence: index + 1,
        receiptHash: testHash(observation),
        completedAt: at(row.dueAt, 4),
        observation,
      })
    })
  const mutations = ['SUBMIT_STARTED', 'SUBMIT_ACCEPTED'].map((eventType, index) => ({
    authorityGenerationHash: candidate.authorityGenerationHash,
    strategyDecisionHash: testHash('mutation decision'),
    event: Schema.decodeUnknownSync(MutationEventSchema)({
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: testHash(eventType),
      mutationId: testHash('mutation'),
      intentId: testHash('intent'),
      sequence: index + 1,
      operation: 'SUBMIT',
      eventType,
      requestHash: testHash('request'),
      consistencyDelayMs: 1000,
      occurredAt: at(original.asOf, 100 + index),
    }),
  }))
  const sourceMaterial = {
    mutations,
    accounts: [
      {
        policy: JevResearchPolicy.Candidate,
        identity,
        forward: {
          unresolvedMutationCount: 0,
          accountingReceiptsExact: true,
          ledgerExact: true,
          missingLedgerAccountCount: 0,
          accountTransactions: [],
          accountCashSettlements: [],
          accountPositionCounts: { reconciledAt: asOf },
        },
      },
    ],
  }
  const cut = {
    ...original,
    asOf,
    mutations,
    controllerPasses: passes,
    sourceMaterial,
    sourceMaterialHash: testHash(sourceMaterial),
    financial: [
      {
        policy: JevResearchPolicy.Candidate,
        sourceHash: testHash(sourceMaterial),
        accountBindingHash: candidate.accountBindingHash,
        definitionHash: testHash(candidate),
        cashHistory: null,
        sessions: registration.calendar.sessions.map((s) => ({
          sessionDate: s.sessionDate,
          evidenceHash: testHash(s),
          facts: null,
        })),
      },
    ],
    durableObservations: [
      ...passes.map((pass) => ({
        kind: 'CONTROLLER' as const,
        sourceHash: pass.receiptHash,
        sourceAt: pass.completedAt,
        witnessedAt: at(pass.completedAt, 1),
        correct: true,
      })),
      ...schedule
        .filter((row) => row.class === ObligationClass.Reconciliation)
        .map((row) => ({
          kind: 'RECONCILIATION' as const,
          sourceHash: testHash(row),
          sourceAt: row.dueAt,
          witnessedAt: at(row.dueAt, 1),
          correct: true,
        })),
      {
        kind: 'MUTATION' as const,
        sourceHash: mutations[1]!.event.eventId,
        sourceAt: mutations[1]!.event.occurredAt,
        witnessedAt: at(mutations[1]!.event.occurredAt, 1),
        correct: true,
      },
    ],
  }
  const { sourceHash: _sourceHash, ...safetyMaterial } = input.safety
  const safety = Result.getOrThrow(makeOperationalSafetyAudit({ ...safetyMaterial, asOf }))
  const verified = new Set([
    registration.calendar.sourceHash,
    ...registration.retainedIncidentSources,
    safety.sourceHash,
    safety.auditEvidenceHash,
  ])
  const evaluate = (source: typeof cut) =>
    Result.getOrThrow(
      verifyStoredOperationalAssessment({ ...input, sourceCutHash: testHash(source), safety }, source, verified),
    )
  return { cut, input, verified, safety, evaluate, registration, build, passes, original, at, schedule }
}

test('unbound in-period workers prevent an otherwise complete certificate without changing retained v1 receipts', () => {
  const { cut, input, verified, safety, evaluate, registration, build, passes, original, at, schedule } =
    completeFixture()
  const complete = evaluate(cut)
  expect(complete.verdict).toBe('OPERATIONALLY_RELIABLE_PAPER')
  expect(complete.missing).toEqual([])
  const replaceControllerBuild = (executionBuild: typeof build | undefined) => {
    const replacements = passes.map((pass) => {
      const { executionBuild: _build, ...material } = pass.observation
      const observation = { ...material, ...(executionBuild === undefined ? {} : { executionBuild }) }
      return { ...pass, observation, receiptHash: testHash(observation) }
    })
    return {
      ...cut,
      controllerPasses: replacements,
      durableObservations: cut.durableObservations.map((witness) => {
        const index = passes.findIndex((pass) => pass.receiptHash === witness.sourceHash)
        return index < 0 ? witness : { ...witness, sourceHash: replacements[index]!.receiptHash }
      }),
    }
  }
  const historicalFor = (source: typeof cut) => {
    const retainedInput = {
      ...input,
      schemaVersion: 'bayn.operational-assessment-input.v1',
      sourceCutHash: testHash(source),
      safety,
    }
    expect(Result.isFailure(evaluateOperationalAssessment(retainedInput, source, verified))).toBe(true)
    return Result.getOrThrow(verifyStoredOperationalAssessment(retainedInput, source, verified))
  }
  const foreignRepository = replaceControllerBuild({ ...build, imageRepository: 'example.test/foreign/worker' })
  const currentForeign = evaluate(foreignRepository)
  expect(currentForeign.verdict).not.toBe('OPERATIONALLY_RELIABLE_PAPER')
  expect(currentForeign.missing.filter((reason) => reason.startsWith('UNBOUND_CONTROLLER_BUILD:'))).toEqual(
    foreignRepository.controllerPasses.map((pass) => `UNBOUND_CONTROLLER_BUILD:${pass.receiptHash}`),
  )
  expect(currentForeign.reliability.classes.find((row) => row.class === ObligationClass.Decision)?.correctOnTime).toBe(
    '0',
  )
  const retainedForeign = historicalFor(foreignRepository)
  expect(retainedForeign.verdict).toBe('OPERATIONALLY_RELIABLE_PAPER')
  // The v38 fixture retains the v1 receipt encoding and foreign-repository completion evidence.
  expect(testHash(retainedForeign)).toBe('361bc0e9077f7f955a6f2d6986d125555e8ebb7773099e3941ba95b13e0ebf68')
  for (const executionBuild of [
    undefined,
    { ...build, sourceRevision: 'b'.repeat(40) },
    { ...build, imageDigest: `sha256:${testHash('different worker image')}` },
  ]) {
    const retainedUnbound = historicalFor(replaceControllerBuild(executionBuild))
    expect(retainedUnbound.verdict).toBe('REJECTED')
    expect(
      retainedUnbound.reliability.classes.find((row) => row.class === ObligationClass.Decision)?.correctOnTime,
    ).toBe('0')
  }
  const observation = {
    result: 'SUCCESS',
    outcome: 'WINDOW_CLOSED',
    executionIssuedAt: at(original.asOf, 20),
    observedAt: at(original.asOf, 25),
    executionBuild: { ...build, sourceRevision: 'b'.repeat(40) },
  }
  const unbound = Schema.decodeUnknownSync(ControllerPassEvidenceSchema)({
    ...passes[0]!,
    sequence: 3,
    completedAt: observation.observedAt,
    receiptHash: testHash(observation),
    observation,
  })
  const changed = { ...cut, controllerPasses: [...passes, unbound] }
  const current = evaluate(changed)
  expect(current.verdict).toBe('INCONCLUSIVE')
  expect(current.missing).toEqual([`UNBOUND_CONTROLLER_BUILD:${unbound.receiptHash}`])
  expect(current.reliability).toEqual(complete.reliability)
  const historicalInput = {
    ...input,
    schemaVersion: 'bayn.operational-assessment-input.v1',
    sourceCutHash: testHash(changed),
    safety,
  }
  const historical = Result.getOrThrow(verifyStoredOperationalAssessment(historicalInput, changed, verified))
  expect(historical.verdict).toBe('OPERATIONALLY_RELIABLE_PAPER')
  expect(historical.missing).toEqual([])
  expect(historical.reliability).toEqual(complete.reliability)
  expect(historical).not.toHaveProperty('evaluationPolicy')
  expect(Result.isFailure(evaluateOperationalAssessment(historicalInput, changed, verified))).toBe(true)
  const closeAt = registration.calendar.sessions.at(-1)!.closeAt
  const tailObservation = {
    ...unbound.observation,
    executionIssuedAt: at(closeAt, 1),
    observedAt: at(closeAt, 2),
  }
  const tail = {
    ...unbound,
    completedAt: tailObservation.observedAt,
    receiptHash: testHash(tailObservation),
    observation: tailObservation,
  }
  expect(evaluate({ ...cut, controllerPasses: [...passes, tail] }).verdict).toBe('OPERATIONALLY_RELIABLE_PAPER')
  for (const invalidClock of [
    { ...tail, observation: { ...tailObservation, observedAt: at(closeAt, -1) } },
    { ...tail, completedAt: at(closeAt, 1) },
    { ...tail, completedAt: at(cut.asOf, 1) },
  ]) {
    const malformedTail = Schema.decodeUnknownSync(ControllerPassEvidenceSchema)(invalidClock)
    const result = evaluate({ ...cut, controllerPasses: [...passes, malformedTail] })
    expect(result.verdict).toBe('INCONCLUSIVE')
    expect(result.missing).toEqual([`UNBOUND_CONTROLLER_BUILD:${tail.receiptHash}`])
    expect(result.reliability).toEqual(complete.reliability)
  }
  const overlapping = { ...tail, observation: { ...tailObservation, executionIssuedAt: at(closeAt, -1) } }
  expect(evaluate({ ...cut, controllerPasses: [...passes, overlapping] }).verdict).toBe('INCONCLUSIVE')
  const { executionIssuedAt: _issued, ...unknownStart } = tailObservation
  expect(evaluate({ ...cut, controllerPasses: [...passes, { ...tail, observation: unknownStart }] }).verdict).toBe(
    'INCONCLUSIVE',
  )
  const lastReconciliation = schedule.filter((row) => row.class === ObligationClass.Reconciliation).at(-1)!
  expect(lastReconciliation.deadlineAt > closeAt).toBe(true)
  const finishing = {
    ...cut,
    durableObservations: cut.durableObservations.map((witness) =>
      witness.sourceHash === testHash(lastReconciliation) ? { ...witness, witnessedAt: at(closeAt, 10) } : witness,
    ),
  }
  expect(evaluate(finishing).verdict).toBe('OPERATIONALLY_RELIABLE_PAPER')
  expect(evaluate({ ...finishing, controllerPasses: [...passes, tail] }).verdict).toBe('INCONCLUSIVE')
})

test('a verified file cannot certify different safety audit values or unverified scan evidence', () => {
  const { cut, input, verified } = fixture()
  const unrelated = testHash('unrelated verified artifact')
  const replaced = { ...input, safety: { ...input.safety, sourceHash: unrelated } }
  const result = Result.getOrThrow(verifyStoredOperationalAssessment(replaced, cut, new Set([...verified, unrelated])))
  expect(result.safety.pass).toBe(false)
  expect(result.missing).toContain('UNBOUND_SAFETY_AUDIT')
  expect(result.verdict).not.toBe('OPERATIONALLY_RELIABLE_PAPER')
  const withoutScan = new Set(verified)
  withoutScan.delete(input.safety.auditEvidenceHash)
  expect(Result.getOrThrow(verifyStoredOperationalAssessment(input, cut, withoutScan)).safety.pass).toBe(false)
})

test('operational accounting requires exact fill receipts and ledger evidence without importing economic qualification gates', () => {
  const { cut: original, input, verified } = fixture()
  const definition = input.registration.policies[0]
  const identity = Result.getOrThrow(
    makeBrokerIdentity({
      schemaVersion: 'bayn.broker-identity.v2',
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      accountId: definition.riskPolicy.accountId,
    }),
  )
  const forward = {
    accountTransactions: [],
    accountCashSettlements: [],
    accountPositionCounts: { reconciledAt: original.asOf },
    unresolvedMutationCount: 0,
    accountingReceiptsExact: true,
    ledgerExact: true,
    missingLedgerAccountCount: 0,
  }
  const evaluate = (flags: typeof forward) => {
    const sourceMaterial = { mutations: [], accounts: [{ policy: 'JEV', identity, forward: flags }] }
    const financial = [
      {
        policy: JevResearchPolicy.Candidate,
        sourceHash: testHash(sourceMaterial),
        accountBindingHash: definition.accountBindingHash,
        definitionHash: testHash(definition),
        cashHistory: null,
        sessions: input.registration.calendar.sessions.map((s) => ({
          sessionDate: s.sessionDate,
          evidenceHash: testHash(s),
          facts: null,
        })),
      },
    ]
    const cut = { ...original, sourceMaterial, sourceMaterialHash: testHash(sourceMaterial), financial }
    return Result.getOrThrow(
      verifyStoredOperationalAssessment({ ...input, sourceCutHash: testHash(cut) }, cut, verified),
    )
  }
  const exact = evaluate(forward)
  expect(exact.missing).not.toContain('INCOMPLETE_FILL_ACCOUNTING')
  expect(exact.economicQualification).toBe('NOT_ASSESSED')
  expect(exact.verdict).toBe('INCONCLUSIVE')
  for (const changed of [
    { ...forward, accountingReceiptsExact: false },
    { ...forward, ledgerExact: false },
    { ...forward, missingLedgerAccountCount: 1 },
  ])
    expect(evaluate(changed).missing).toContain('INCOMPLETE_FILL_ACCOUNTING')
})

// Exercise real digest/schema/source replay through a read-only SQL transport, without a database or forged brand.
const archivedFixture = (source: typeof SystemSourceCutSchema.Type) => {
  const records = source.controllerPasses.map((pass) =>
    Result.getOrThrow(makeSystemSourceRecord(SystemSourceRecordKind.Controller, pass)),
  )
  const manifest = Schema.decodeUnknownSync(OperationalSourceCutSchema)({
    ...source,
    schemaVersion: 'bayn.operational-source-cut.v1',
    records: records.map((record, index) => ({
      kind: record.kind,
      sourceId: source.controllerPasses[index]!.receiptHash,
      recordHash: record.recordHash,
    })),
  })
  const payloadText = Result.getOrThrow(canonicalJsonV1Result(manifest))
  const hash = testHash(manifest)
  const sql = ((strings: TemplateStringsArray, ...values: readonly unknown[]) => {
    const query = strings.join('?')
    if (query.includes('FROM system_evidence_cuts')) return Effect.succeed(values[0] === hash ? [{ payloadText }] : [])
    if (query.includes('FROM system_source_records'))
      return Effect.succeed(records.filter((record) => record.recordHash === values[0]))
    return Effect.die(new Error('Unexpected SQL in read-only archived fixture'))
  }) as unknown as PgClient.PgClient
  return { manifest, hash, sql, records }
}

test('archive replay retains unwitnessed controller provenance and cannot downgrade current evaluation', async () => {
  const { cut, input, verified, safety, build, passes, original, at } = completeFixture()
  const read = async (source: typeof cut) => {
    const archive = archivedFixture(source)
    const current = await Effect.runPromise(
      readOperationalAssessmentSourceCut(archive.hash, input.registration).pipe(
        Effect.provideService(PgClient.PgClient, archive.sql),
      ),
    )
    const retained = await Effect.runPromise(
      readOperationalAssessmentSourceCut(archive.hash, input.registration, 'RETAINED_OPERATIONAL_V1').pipe(
        Effect.provideService(PgClient.PgClient, archive.sql),
      ),
    )
    const currentInput = { ...input, sourceCutHash: archive.hash, safety }
    const retainedInput = { ...currentInput, schemaVersion: 'bayn.operational-assessment-input.v1' }
    expect(Result.isFailure(verifyStoredOperationalAssessment(currentInput, retained, verified))).toBe(true)
    expect(Result.isFailure(verifyStoredOperationalAssessment(retainedInput, current, verified))).toBe(true)
    expect(Result.isFailure(evaluateOperationalAssessment(retainedInput, retained, verified))).toBe(true)
    return {
      archive,
      replay: current,
      current: Result.getOrThrow(verifyStoredOperationalAssessment(currentInput, current, verified)),
      retained: Result.getOrThrow(verifyStoredOperationalAssessment(retainedInput, retained, verified)),
    }
  }
  const baseline = await read(cut)
  expect(baseline.current.verdict).toBe('OPERATIONALLY_RELIABLE_PAPER')
  expect(baseline.retained.verdict).toBe('OPERATIONALLY_RELIABLE_PAPER')
  for (const executionBuild of [
    undefined,
    { ...build, sourceRevision: 'b'.repeat(40) },
    { ...build, imageDigest: `sha256:${testHash('different archived worker image')}` },
    { ...build, imageRepository: 'example.test/foreign/unwitnessed-worker' },
  ]) {
    const observation = {
      result: 'SUCCESS',
      outcome: 'WINDOW_CLOSED',
      executionIssuedAt: at(original.asOf, 20),
      observedAt: at(original.asOf, 25),
      ...(executionBuild === undefined ? {} : { executionBuild }),
    }
    const unbound = Schema.decodeUnknownSync(ControllerPassEvidenceSchema)({
      ...passes[0]!,
      sequence: 3,
      completedAt: observation.observedAt,
      receiptHash: testHash(observation),
      observation,
    })
    const changed = await read({ ...cut, controllerPasses: [...passes, unbound] })
    expect(isVerifiedOperationalSourceCut(changed.replay)).toBe(true)
    if (!isVerifiedOperationalSourceCut(changed.replay)) throw new Error('Expected verified archive')
    expect(changed.replay.unboundControllerBuilds).toHaveLength(1)
    expect(changed.replay.work.controllerWork.has(unbound.receiptHash)).toBe(false)
    expect(changed.replay.unboundControllerBuilds[0]).toEqual({
      receiptHash: unbound.receiptHash,
      completedAt: unbound.completedAt,
      executionIssuedAt: observation.executionIssuedAt,
      observedAt: observation.observedAt,
    })
    expect(changed.current.verdict).toBe('INCONCLUSIVE')
    expect(changed.current.missing).toEqual([`UNBOUND_CONTROLLER_BUILD:${unbound.receiptHash}`])
    expect(changed.current.reliability).toEqual(baseline.current.reliability)
    expect(changed.retained.verdict).toBe('OPERATIONALLY_RELIABLE_PAPER')
    expect(changed.retained.missing).toEqual([])
    expect(changed.retained).not.toHaveProperty('evaluationPolicy')
    expect(changed.retained.reliability).toEqual(baseline.retained.reliability)
  }
})

test('archive replay preserves retained completion matching and rejects tampered source records', async () => {
  const { cut, input, verified, safety, build, passes } = completeFixture()
  for (const executionBuild of [
    { ...build, imageRepository: 'example.test/foreign/worker' },
    undefined,
    { ...build, sourceRevision: 'b'.repeat(40) },
    { ...build, imageDigest: `sha256:${testHash('different archived completion image')}` },
  ]) {
    const replacements = passes.map((pass) => {
      const { executionBuild: _build, ...material } = pass.observation
      const observation = { ...material, ...(executionBuild === undefined ? {} : { executionBuild }) }
      return { ...pass, observation, receiptHash: testHash(observation) }
    })
    const source = {
      ...cut,
      controllerPasses: replacements,
      durableObservations: cut.durableObservations.map((witness) => {
        const index = passes.findIndex((pass) => pass.receiptHash === witness.sourceHash)
        return index < 0 ? witness : { ...witness, sourceHash: replacements[index]!.receiptHash }
      }),
    }
    const archive = archivedFixture(source)
    const replay = await Effect.runPromise(
      readOperationalAssessmentSourceCut(archive.hash, input.registration, 'RETAINED_OPERATIONAL_V1').pipe(
        Effect.provideService(PgClient.PgClient, archive.sql),
      ),
    )
    const retained = Result.getOrThrow(
      verifyStoredOperationalAssessment(
        {
          ...input,
          schemaVersion: 'bayn.operational-assessment-input.v1',
          sourceCutHash: archive.hash,
          safety,
        },
        replay,
        verified,
      ),
    )
    const matched =
      executionBuild?.sourceRevision === build.sourceRevision && executionBuild?.imageDigest === build.imageDigest
    expect(retained.verdict).toBe(matched ? 'OPERATIONALLY_RELIABLE_PAPER' : 'REJECTED')
    expect(retained.reliability.classes.find((row) => row.class === ObligationClass.Decision)?.correctOnTime).toBe(
      matched ? '2' : '0',
    )
    expect(retained.missing.some((reason) => reason.startsWith('UNBOUND_CONTROLLER_BUILD:'))).toBe(false)
    const currentReplay = await Effect.runPromise(
      readOperationalAssessmentSourceCut(archive.hash, input.registration).pipe(
        Effect.provideService(PgClient.PgClient, archive.sql),
      ),
    )
    const current = Result.getOrThrow(
      verifyStoredOperationalAssessment({ ...input, sourceCutHash: archive.hash, safety }, currentReplay, verified),
    )
    expect(current.verdict).not.toBe('OPERATIONALLY_RELIABLE_PAPER')
    expect(current.missing.filter((reason) => reason.startsWith('UNBOUND_CONTROLLER_BUILD:'))).toEqual(
      replacements.map((pass) => `UNBOUND_CONTROLLER_BUILD:${pass.receiptHash}`),
    )
    expect(current.reliability.classes.find((row) => row.class === ObligationClass.Decision)?.correctOnTime).toBe('0')
    const originalHash = archive.records[0]!.recordHash
    archive.records[0]!.payloadText = '{}'
    expect(
      await Effect.runPromise(
        readOperationalAssessmentSourceCut(archive.hash, input.registration).pipe(
          Effect.provideService(PgClient.PgClient, archive.sql),
          Effect.result,
        ),
      ).then(Result.isFailure),
    ).toBe(true)
    expect(archive.records[0]!.recordHash).toBe(originalHash)
  }
})

test('an archived null-plan registration remains historical evidence but fails the current plan gate', async () => {
  const { cut, input, verified } = fixture(null)
  const archive = archivedFixture(cut)
  const current = await Effect.runPromise(
    readOperationalAssessmentSourceCut(archive.hash, input.registration).pipe(
      Effect.provideService(PgClient.PgClient, archive.sql),
    ),
  )
  const retained = await Effect.runPromise(
    readOperationalAssessmentSourceCut(archive.hash, input.registration, 'RETAINED_OPERATIONAL_V1').pipe(
      Effect.provideService(PgClient.PgClient, archive.sql),
    ),
  )
  const currentResult = Result.getOrThrow(
    verifyStoredOperationalAssessment({ ...input, sourceCutHash: archive.hash }, current, verified),
  )
  const retainedResult = Result.getOrThrow(
    verifyStoredOperationalAssessment(
      {
        ...input,
        sourceCutHash: archive.hash,
        schemaVersion: 'bayn.operational-assessment-input.v1',
      },
      retained,
      verified,
    ),
  )
  expect(currentResult.missing).toContain('UNBOUND_CONTROLLER_PLAN')
  expect(currentResult.verdict).not.toBe('OPERATIONALLY_RELIABLE_PAPER')
  expect(retainedResult.missing).not.toContain('UNBOUND_CONTROLLER_PLAN')
})
