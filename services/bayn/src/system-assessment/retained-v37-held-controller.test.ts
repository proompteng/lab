import { expect, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Effect, Result, Schema } from 'effect'

import { RetainedAutonomousCyclePassObservationSchema } from '../cycle/runner/pass-observation'
import { canonicalJsonV1Result } from '../hash'
import { decideJevPositionHold, JevPositionHoldSchema } from '../jev/hold'
import { decodeJevProtocol, RetainedJevProtocolV37Schema } from '../jev/protocol'
import { RetainedV37JevPositionHoldSchema } from '../jev/retained-v37-hold'
import { strictParseOptions } from '../schemas'
import { ControllerPassEvidenceSchema, RetainedV37ControllerPassEvidenceSchema } from './decision-work'
import { testHash } from './fixtures.test-support'
import original from './original-v37-held-controller.test-fixture.json'
import registrationSource from './original-v37-operational.test-fixture.json'
import { evaluateOperationalAssessment } from './operational-assessment'
import { OperationalRegistrationSchema, validateOperationalRegistration } from './operational-period'
import { readOperationalAssessmentSourceCut } from './operational-source-cut'
import { readPersistedOperationalAssessment } from './postgres'
import { makeSystemSourceRecord, SystemSourceRecordKind } from './source-records'

// Synthetic native fixture, hold decision, source record, cut and receipt reproduced by
// original.sourceRevision (0506c9d7) with Effect 4.1.4. This matches the nested historical
// failure shape; it contains no production account, grant or provider evidence.
const registration = Schema.decodeUnknownSync(OperationalRegistrationSchema)(registrationSource.input.registration)
const hold = original.pass.observation.positionHold
const decodeHold = Schema.decodeUnknownResult(RetainedV37JevPositionHoldSchema, strictParseOptions)

const stored = (pass: unknown = original.pass) => {
  const record = Result.getOrThrow(makeSystemSourceRecord(SystemSourceRecordKind.Controller, pass))
  const cut = {
    ...original.cut,
    records: [
      {
        kind: SystemSourceRecordKind.Controller,
        sourceId: original.controllerReceiptHash,
        recordHash: record.recordHash,
      },
    ],
  }
  return { record, cut, sourceCutHash: testHash(cut) }
}

const read = <A, E>(operation: Effect.Effect<A, E, PgClient.PgClient>, source = stored()) => {
  const sql = ((strings: TemplateStringsArray, ...values: readonly unknown[]) => {
    const query = strings.join('?')
    if (query.includes('FROM operational_assessment_receipts'))
      return Effect.succeed(
        values[0] === original.assessmentHash
          ? [
              {
                input: { ...registrationSource.input, sourceCutHash: original.sourceCutHash },
                verifiedSourceHashes: registrationSource.verifiedSourceHashes,
              },
            ]
          : [],
      )
    if (query.includes('FROM system_evidence_cuts'))
      return Effect.succeed(
        values[0] === source.sourceCutHash
          ? [{ payloadText: Result.getOrThrow(canonicalJsonV1Result(source.cut)) }]
          : [],
      )
    if (query.includes('FROM system_source_records'))
      return Effect.succeed(values[0] === source.record.recordHash ? [source.record] : [])
    if (query.includes('FROM system_qualification_registrations'))
      return Effect.succeed(values[0] === registrationSource.registrationHash ? [{ payload: registration }] : [])
    return Effect.die(new Error('Unexpected SQL in retained held-controller read-only fixture'))
  }) as unknown as PgClient.PgClient
  return Effect.runPromise(operation.pipe(Effect.provideService(PgClient.PgClient, sql), Effect.result))
}

test('retained v37 hold and controller reproduce the original canonical bytes and hashes', () => {
  const decoded = Result.getOrThrow(decodeHold(hold))
  const pass = Schema.decodeUnknownSync(RetainedV37ControllerPassEvidenceSchema, strictParseOptions)(original.pass)
  expect(Result.getOrThrow(canonicalJsonV1Result(decoded))).toBe(Result.getOrThrow(canonicalJsonV1Result(hold)))
  expect(Result.getOrThrow(canonicalJsonV1Result(pass))).toBe(Result.getOrThrow(canonicalJsonV1Result(original.pass)))
  expect(testHash(decoded)).toBe(original.holdHash)
  expect(testHash(decoded.evidence.protocol)).toBe(original.parameterHash)
  expect(original.parameterHash).toBe(registrationSource.parameterHash)
  expect(stored().record.recordHash).toBe(original.recordHash)
  expect(testHash(stored().cut)).toBe(original.sourceCutHash)
  expect(pass.receiptHash).toBe(original.controllerReceiptHash)
})

test('public retained source and receipt readers preserve the original rejected outcome and receipt hash', async () => {
  const cut = Result.getOrThrow(
    await read(readOperationalAssessmentSourceCut(original.sourceCutHash, registration, 'RETAINED_OPERATIONAL_V1')),
  )
  const receipt = Result.getOrThrow(await read(readPersistedOperationalAssessment(original.assessmentHash)))
  expect(receipt.assessmentHash).toBe(original.assessmentHash)
  expect(receipt.sourceCutHash).toBe(original.sourceCutHash)
  expect(receipt.registrationHash).toBe(registrationSource.registrationHash)
  expect(receipt.verdict).toBe('REJECTED')
  expect(receipt.economicQualification).toBe('NOT_ASSESSED')
  expect(receipt.missing).toEqual(original.missing)
  const { assessmentHash, ...material } = receipt
  expect(testHash(material)).toBe(assessmentHash)
  expect(
    Result.isFailure(
      evaluateOperationalAssessment(
        { schemaVersion: 'bayn.operational-assessment-input.v3', registration, sourceCutHash: original.sourceCutHash },
        cut,
        new Set(registrationSource.verifiedSourceHashes),
      ),
    ),
  ).toBe(true)
})

test('current registration, protocol, hold and controller admission still reject the original v37 evidence', () => {
  expect(Result.isFailure(validateOperationalRegistration(registration))).toBe(true)
  expect(Result.isFailure(decodeJevProtocol(hold.evidence.protocol))).toBe(true)
  expect(Result.isFailure(decideJevPositionHold(hold.evidence))).toBe(true)
  expect(Result.isFailure(Schema.decodeUnknownResult(JevPositionHoldSchema, strictParseOptions)(hold))).toBe(true)
  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(
        RetainedAutonomousCyclePassObservationSchema,
        strictParseOptions,
      )(original.pass.observation),
    ),
  ).toBe(true)
  expect(
    Result.isFailure(Schema.decodeUnknownResult(ControllerPassEvidenceSchema, strictParseOptions)(original.pass)),
  ).toBe(true)
})

test('retained hold rejects unknown and altered v37 identities even with recomputed archive digests', async () => {
  const alteredParameters = { ...hold.evidence.protocol, maximumDecisionLagMs: 59_000 }
  // The general historical shape permits this number; this reader requires the exact frozen identity.
  expect(Result.isSuccess(Schema.decodeUnknownResult(RetainedJevProtocolV37Schema)(alteredParameters))).toBe(true)
  for (const protocol of [
    { ...hold.evidence.protocol, schemaVersion: 'bayn.jev.protocol.unknown' },
    { ...hold.evidence.protocol, entryQuestionPolicyHash: '0'.repeat(64) },
    alteredParameters,
  ]) {
    const changed = { ...hold, evidence: { ...hold.evidence, protocol } }
    expect(Result.isFailure(decodeHold(changed))).toBe(true)
    const source = stored({ ...original.pass, observation: { ...original.pass.observation, positionHold: changed } })
    expect(source.record.recordHash).not.toBe(original.recordHash)
    expect(source.sourceCutHash).not.toBe(original.sourceCutHash)
    expect(
      Result.isFailure(
        await read(
          readOperationalAssessmentSourceCut(source.sourceCutHash, registration, 'RETAINED_OPERATIONAL_V1'),
          source,
        ),
      ),
    ).toBe(true)
  }
})

test('retained hold must still reproduce its deadline, decision identity and executable price evidence', async () => {
  for (const changed of [
    { ...hold, validUntil: new Date(Date.parse(hold.validUntil) + 1).toISOString() },
    { ...hold, entryDecisionHash: '0'.repeat(64) },
    { ...hold, evidence: { ...hold.evidence, observedAt: new Date(Date.parse(hold.validUntil) + 1).toISOString() } },
  ]) {
    expect(Result.isFailure(decodeHold(changed))).toBe(true)
    const source = stored({ ...original.pass, observation: { ...original.pass.observation, positionHold: changed } })
    expect(
      Result.isFailure(
        await read(
          readOperationalAssessmentSourceCut(source.sourceCutHash, registration, 'RETAINED_OPERATIONAL_V1'),
          source,
        ),
      ),
    ).toBe(true)
  }
})

test('retained reader continues to reject noncanonical or altered archived source bytes', async () => {
  const source = stored()
  for (const payloadText of [
    source.record.payloadText + ' ',
    source.record.payloadText.replace('retained-v37-hold-test', 'changed-held-account'),
  ]) {
    expect(payloadText).not.toBe(source.record.payloadText)
    expect(
      Result.isFailure(
        await read(
          readOperationalAssessmentSourceCut(original.sourceCutHash, registration, 'RETAINED_OPERATIONAL_V1'),
          { ...source, record: { ...source.record, payloadText } },
        ),
      ),
    ).toBe(true)
  }
})
