import { JevResearchPolicy } from '../jev/acceptance'
import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'
import { operationalRegistrationFixture } from './operational-period.test-support'
import { evaluateOperationalAssessment } from './operational-assessment'
import { emptySourceCutFixture } from './source-cut.test-support'
import { SystemSourceCutSchema } from './source-cut'
import { testHash } from './fixtures.test-support'
import { SafetyViolationKind } from './assessment'
import { ObligationClass, ReliabilityStatus } from './reliability'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'

const fixture = () => {
  const registration = operationalRegistrationFixture()
  const { cut: base } = emptySourceCutFixture()
  const cut = Schema.decodeUnknownSync(SystemSourceCutSchema)({
    ...base,
    registrationHash: testHash(registration),
    asOf: registration.calendar.sessions[0]!.openAt,
    runtimeConfigurationHash: registration.obligations.runtimeConfigurationHash,
    financial: [],
  })
  const input = {
    schemaVersion: 'bayn.operational-assessment-input.v1',
    registration,
    sourceCutHash: testHash(cut),
    safety: {
      coverage: 'COMPLETE',
      sourceHash: testHash('safety audit'),
      registrationHash: cut.registrationHash,
      asOf: cut.asOf,
      violations: [],
    },
  }
  const verified = new Set([
    registration.calendar.sourceHash,
    ...registration.retainedIncidentSources,
    input.safety.sourceHash,
  ])
  return { cut, input, verified }
}

test('an open operating period and missing accounting cannot become a reliability certificate', () => {
  const { cut, input, verified } = fixture()
  const result = Result.getOrThrow(evaluateOperationalAssessment(input, cut, verified))
  expect(result.verdict).toBe('INCONCLUSIVE')
  expect(result.economicQualification).toBe('NOT_ASSESSED')
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
      evaluateOperationalAssessment({ ...input, reliability: { good: 1000, scheduled: 1000 } }, cut, verified),
    ),
  ).toBe(true)
})

test('scheduled work that never starts stays in the closed period denominator', () => {
  const { cut: original, input, verified } = fixture()
  const asOf = '2026-11-04T00:03:00.000Z'
  const cut = { ...original, asOf }
  const result = Result.getOrThrow(
    evaluateOperationalAssessment(
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
    evaluateOperationalAssessment({ ...input, sourceCutHash: testHash(cut) }, cut, verified),
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
    Result.getOrThrow(evaluateOperationalAssessment({ ...input, sourceCutHash: testHash(changed) }, changed, verified))
      .missing,
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
  expect(Result.getOrThrow(evaluateOperationalAssessment(unsafe, cut, verified)).verdict).toBe('REJECTED')
  expect(
    Result.isFailure(
      evaluateOperationalAssessment(input, { ...cut, registrationHash: testHash('another period') }, verified),
    ),
  ).toBe(true)
  const foreign = { ...cut, financial: [{ ...originalFinancial(), policy: JevResearchPolicy.Candidate }] }
  expect(
    Result.isFailure(evaluateOperationalAssessment({ ...input, sourceCutHash: testHash(foreign) }, foreign, verified)),
  ).toBe(true)
})

const originalFinancial = () => emptySourceCutFixture().cut.financial[0]!
