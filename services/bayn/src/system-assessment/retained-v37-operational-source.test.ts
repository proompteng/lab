import { expect, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Effect, Result, Schema } from 'effect'

import original from './original-v37-operational.test-fixture.json'
import { canonicalJsonV1Result } from '../hash'
import { JevAcceptanceVersion } from '../jev/acceptance'
import { decodeJevProtocol, RetainedJevProtocolV37Schema } from '../jev/protocol'
import { registrationFixture, testHash } from './fixtures.test-support'
import { evaluateOperationalAssessment, verifyStoredOperationalAssessment } from './operational-assessment'
import { operationalRegistrationFixture } from './operational-period.test-support'
import {
  OperationalRegistrationSchema,
  validateOperationalRegistration,
  verifyStoredOperationalRegistration,
} from './operational-period'
import { readAssessmentRegistration, readPersistedOperationalAssessment } from './postgres'
import { RecordedSystemSourceCutSchema } from './recorded-source-cut'

// Generated only from synthetic fixtures and the evaluator at original.sourceRevision.
// Preserve these bytes and goldens; no broker, grant, provider or database operation created this receipt.
const registration = Schema.decodeUnknownSync(OperationalRegistrationSchema)(original.input.registration)
const cut = Schema.decodeUnknownSync(RecordedSystemSourceCutSchema)(original.cut)
const verifiedSources = new Set(original.verifiedSourceHashes)

const read = <A, E>(
  operation: Effect.Effect<A, E, PgClient.PgClient>,
  storedRegistration: unknown = registration,
  storedCut: unknown = cut,
) => {
  const sql = ((strings: TemplateStringsArray, ...values: readonly unknown[]) => {
    const query = strings.join('?')
    if (query.includes('FROM operational_assessment_receipts'))
      return Effect.succeed(
        values[0] === original.assessmentHash
          ? [{ input: original.input, verifiedSourceHashes: original.verifiedSourceHashes }]
          : [],
      )
    if (query.includes('FROM system_evidence_cuts'))
      return Effect.succeed(
        values[0] === original.sourceCutHash
          ? [{ payloadText: Result.getOrThrow(canonicalJsonV1Result(storedCut)) }]
          : [],
      )
    if (query.includes('FROM system_qualification_registrations'))
      return Effect.succeed(values[0] === original.registrationHash ? [{ payload: storedRegistration }] : [])
    return Effect.die(new Error('Unexpected SQL in retained read-only fixture'))
  }) as unknown as PgClient.PgClient
  return Effect.runPromise(operation.pipe(Effect.provideService(PgClient.PgClient, sql), Effect.result))
}

test('retained v37 registration preserves its original source identity without admitting current work', async () => {
  const verified = Result.getOrThrow(verifyStoredOperationalRegistration(original.input.registration))
  expect(verified.registration).toEqual(registration)
  expect(verified.registrationHash).toBe(original.registrationHash)
  expect(testHash(registration.obligations.configuration.protocol)).toBe(original.parameterHash)
  expect(Result.getOrThrow(await read(readAssessmentRegistration(original.registrationHash)))).toEqual(registration)
  expect(Result.isFailure(validateOperationalRegistration(registration))).toBe(true)
  expect(Result.isFailure(decodeJevProtocol(registration.obligations.configuration.protocol))).toBe(true)
  expect(
    Result.isFailure(
      evaluateOperationalAssessment(
        { schemaVersion: 'bayn.operational-assessment-input.v3', registration, sourceCutHash: original.sourceCutHash },
        cut,
        verifiedSources,
      ),
    ),
  ).toBe(true)
})

test('public retained v37 receipt replay reproduces the original hash and inconclusive outcome', async () => {
  const assessment = Result.getOrThrow(verifyStoredOperationalAssessment(original.input, cut, verifiedSources))
  const material = { ...assessment, verifiedSourceHashes: original.verifiedSourceHashes }
  expect(testHash(material)).toBe(original.assessmentHash)
  expect(assessment.registrationHash).toBe(original.registrationHash)
  expect(assessment.sourceCutHash).toBe(original.sourceCutHash)
  expect(assessment.verdict).toBe('INCONCLUSIVE')
  expect(assessment.economicQualification).toBe('NOT_ASSESSED')
  expect(assessment.missing).toEqual([
    'OPEN_REPORTING_PERIOD',
    'INCOMPLETE_FILL_ACCOUNTING',
    'INCOMPLETE_MUTATION_SOURCE_COVERAGE',
  ])
  expect(assessment).not.toHaveProperty('evaluationPolicy')
  expect(Result.getOrThrow(await read(readPersistedOperationalAssessment(original.assessmentHash)))).toEqual({
    ...material,
    assessmentHash: original.assessmentHash,
  })
  expect(testHash(registration)).toBe(original.registrationHash)
  expect(testHash(cut)).toBe(original.sourceCutHash)
})

test('retained v37 reads reject unknown protocols, forged identities and altered source bytes', async () => {
  const configuration = registration.obligations.configuration
  for (const protocol of [
    { ...configuration.protocol, schemaVersion: 'bayn.jev.protocol.unknown' },
    { ...configuration.protocol, schemaVersion: 'bayn.jev.protocol.v38' },
    { ...configuration.protocol, maximumEntryLimitSlippageBps: 0 },
  ]) {
    const changed = {
      ...registration,
      obligations: { ...registration.obligations, configuration: { ...configuration, protocol } },
    }
    expect(Result.isFailure(verifyStoredOperationalRegistration(changed))).toBe(true)
    expect(Result.isFailure(await read(readPersistedOperationalAssessment(original.assessmentHash), changed))).toBe(
      true,
    )
  }
  const changed = {
    ...registration,
    policies: [{ ...registration.policies[0]!, protocolHash: '0'.repeat(64) }],
  }
  expect(Result.isFailure(verifyStoredOperationalRegistration(changed))).toBe(true)
  expect(
    Result.isFailure(
      await read(readPersistedOperationalAssessment(original.assessmentHash), registration, {
        ...cut,
        asOf: '2026-11-04T00:03:00.000Z',
      }),
    ),
  ).toBe(true)
})

test('self-consistent synthetic authority cannot substitute different v37 parameters for the frozen source', () => {
  const protocol = Schema.decodeUnknownSync(RetainedJevProtocolV37Schema)({
    ...registration.obligations.configuration.protocol,
    maximumDecisionLagMs: 59_000,
  })
  const base = registrationFixture(undefined, 20, JevAcceptanceVersion.RetainedV5)
  const forged = operationalRegistrationFixture({
    ...base,
    obligations: { ...base.obligations, configuration: { ...base.obligations.configuration, protocol } },
    policies: base.policies.map((policy) =>
      policy.policy === 'JEV' ? { ...policy, parametersHash: testHash(protocol) } : policy,
    ),
  })
  const result = verifyStoredOperationalRegistration(forged)
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isSuccess(result) || result.failure._tag !== 'SystemAssessmentError')
    throw new Error('Expected the original native strategy binding to reject substituted parameters')
  expect(result.failure.message).toBe('Operational schedule must bind the authorized native strategy')
})
