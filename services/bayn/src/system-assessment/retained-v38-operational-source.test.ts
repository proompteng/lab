import { expect, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Effect, Result, Schema } from 'effect'

import { canonicalJsonV1Result } from '../hash'
import { MarketKind } from '../instruments'
import { JevAcceptanceVersion } from '../jev/acceptance'
import { retainedV38ExecutionFixture, retainedV38ExecutionGoldens } from '../jev/retained-v38-execution.test-support'
import { isContinuousMarket } from '../market-hours'
import { registrationFixture, testHash } from './fixtures.test-support'
import { decisionMarketScopeSupported } from './decision-work'
import { operationalRegistrationFixture } from './operational-period.test-support'
import { bindOperationalObligations, registeredDecisionWork } from './operational-obligations'
import { validateOperationalRegistration, verifyStoredOperationalRegistration } from './operational-period'
import {
  OperationalSourceCutSchema,
  isVerifiedOperationalSourceCut,
  readOperationalAssessmentSourceCut,
} from './operational-source-cut'
import { RecordedSystemSourceCutSchema } from './recorded-source-cut'
import { SystemSourceCutSchema } from './source-cut'
import { emptySourceCutFixture } from './source-cut.test-support'
import { makeSystemSourceRecord, SystemSourceRecordKind } from './source-records'

const fixture = (index: number, current = false) => {
  const { document } = retainedV38ExecutionFixture(index)
  const binding = document.executionSession
  if (binding === undefined || isContinuousMarket(binding.calendar))
    throw new Error('Expected original equity execution')
  const base = operationalRegistrationFixture(
    registrationFixture(undefined, 20, current ? JevAcceptanceVersion.Current : JevAcceptanceVersion.RetainedV5),
  )
  // The independent execution fixture predates the reporting interval and its unrelated capital generation.
  // Replaying it preserves context without inventing registered work, authority, or a completion.
  const openAt = new Date(Date.parse(document.createdAt) + 60_000).toISOString()
  const closeAt = new Date(Date.parse(openAt) + 60_000).toISOString()
  const registration = {
    ...base,
    registeredAt: '2026-09-03T00:00:00.000Z',
    calendar: {
      ...base.calendar,
      sourceHash: testHash(binding.calendar),
      marketCalendar: binding.calendar,
      sessions: [{ sessionDate: binding.executionSession.date, openAt, closeAt }],
    },
  }
  const { cut: empty } = emptySourceCutFixture()
  const cut = {
    ...empty,
    registrationHash: testHash(registration),
    runtimeConfigurationHash: registration.obligations.runtimeConfigurationHash,
    asOf: new Date(Date.parse(closeAt) + 60_000).toISOString(),
    financial: [],
    inference: [],
    decisions: [{ sessionDate: binding.executionSession.date, document }],
  }
  const record = Result.getOrThrow(makeSystemSourceRecord(SystemSourceRecordKind.Decision, cut.decisions[0]))
  const manifest = Schema.decodeUnknownSync(OperationalSourceCutSchema)({
    ...cut,
    schemaVersion: 'bayn.operational-source-cut.v1',
    records: [{ kind: record.kind, sourceId: document.contentHash, recordHash: record.recordHash }],
  })
  const read = (source: unknown, payloadText = record.payloadText) => {
    const hash = testHash(source)
    const sourceText = Result.getOrThrow(canonicalJsonV1Result(source))
    const sql = ((strings: TemplateStringsArray, ...values: readonly unknown[]) => {
      const query = strings.join('?')
      if (query.includes('FROM system_evidence_cuts'))
        return Effect.succeed(values[0] === hash ? [{ payloadText: sourceText }] : [])
      if (query.includes('FROM system_source_records'))
        return Effect.succeed(values[0] === record.recordHash ? [{ ...record, payloadText }] : [])
      return Effect.die(new Error('Unexpected SQL in retained read-only fixture'))
    }) as unknown as PgClient.PgClient
    return Effect.runPromise(
      readOperationalAssessmentSourceCut(hash, registration).pipe(
        Effect.provideService(PgClient.PgClient, sql),
        Effect.result,
      ),
    )
  }
  return { document, registration, cut, manifest, record, read }
}

test.each(retainedV38ExecutionGoldens.flatMap((golden, index) => (golden.market === MarketKind.Equity ? [index] : [])))(
  'public operational replay preserves genuine v38 execution context: %i',
  async (index) => {
    const f = fixture(index)
    expect(Result.isSuccess(verifyStoredOperationalRegistration(f.registration))).toBe(true)
    expect(Result.isFailure(validateOperationalRegistration(f.registration))).toBe(true)
    const replay = Result.getOrThrow(await f.read(f.manifest))
    expect(isVerifiedOperationalSourceCut(replay)).toBe(true)
    if (!isVerifiedOperationalSourceCut(replay)) throw new Error('Expected verified immutable source replay')
    expect(replay.work.documentWork.has(f.document.contentHash)).toBe(true)
    expect(replay.work.documentWork.get(f.document.contentHash)).toBeUndefined()
    expect(replay.admissions.witnesses).toEqual([])
    const oldCut = Schema.decodeUnknownSync(RecordedSystemSourceCutSchema)(f.cut)
    expect(Result.isFailure(Schema.decodeUnknownResult(SystemSourceCutSchema)(oldCut))).toBe(true)
    const inline = Result.getOrThrow(await f.read(oldCut))
    if (isVerifiedOperationalSourceCut(inline)) throw new Error('Expected original inline source representation')
    expect(inline.decisions[0]?.document.contentHash).toBe(f.document.contentHash)
    expect(Result.isFailure(await f.read(f.manifest, '{}'))).toBe(true)
  },
)

test('historical operational replay rejects a v38 document bound to a current registration', async () => {
  const f = fixture(0, true)
  expect(Result.isSuccess(validateOperationalRegistration(f.registration))).toBe(true)
  expect(Result.isFailure(await f.read(f.manifest))).toBe(true)
  expect(Result.isFailure(await f.read(f.cut))).toBe(true)
})

test('verified retained crypto execution does not widen the equity operational source scope', () => {
  const index = retainedV38ExecutionGoldens.findIndex((golden) => golden.market === MarketKind.Crypto)
  const { document } = retainedV38ExecutionFixture(index)
  const f = fixture(0)
  expect(Result.isSuccess(verifyStoredOperationalRegistration(f.registration))).toBe(true)
  expect(decisionMarketScopeSupported(document, f.registration)).toBe(false)
})

test.each(
  retainedV38ExecutionGoldens.flatMap((golden, index) => (/ablation|momentum/.test(golden.name) ? [index] : [])),
)('retained control policy alone prevents candidate work and completion credit: %i', (index) => {
  const f = fixture(index)
  const { document } = f
  const riskPolicy = document.riskPolicy
  if (riskPolicy === undefined) throw new Error('Expected original trading risk policy')
  const candidate = f.registration.policies[0]
  const { capitalAuthorization: _authorization, ...policy } = candidate
  // Isolate the work-binding rule, not activation: original synthetic generations cannot be rebound
  // to a genuine candidate mandate. Public reader tests above separately preserve authentic registrations.
  const openAt = new Date(Date.parse(document.createdAt) - 60_000).toISOString()
  const closeAt = new Date(Date.parse(document.createdAt) + 60_000).toISOString()
  const registration = {
    ...f.registration,
    calendar: {
      ...f.registration.calendar,
      sessions: [{ ...f.registration.calendar.sessions[0]!, openAt, closeAt }],
    },
    policies: [
      {
        ...policy,
        accountBindingHash: testHash({
          schemaVersion: 'bayn.inference-cost-account.v1',
          accountId: document.bindings.accountId,
        }),
        authorityGenerationHash: document.bindings.authorityGenerationHash,
        riskPolicyHash: document.bindings.policyHash,
        riskPolicy,
      },
    ],
  }
  expect(registration.policies[0]!.riskPolicy.accountId).toBe(document.bindings.accountId)
  expect(registration.policies[0]!.protocolHash).not.toBe(document.bindings.strategyProtocolHash)
  expect(registeredDecisionWork(document, registration)).toBeUndefined()
  const cut = {
    ...f.cut,
    registrationHash: testHash(registration),
    asOf: closeAt,
    durableObservations: [
      {
        kind: 'DECISION' as const,
        sourceHash: document.contentHash,
        sourceAt: document.createdAt,
        witnessedAt: document.createdAt,
        correct: true,
      },
    ],
  }
  expect(
    Result.getOrThrow(bindOperationalObligations(cut, registration, testHash(cut))).reliability.completions,
  ).toEqual([])
  // Changing only the strategy-policy binding supplies work and a completion; no fixture bytes change.
  const samePolicy = {
    ...registration,
    policies: registration.policies.map((definition) => ({
      ...definition,
      protocolHash: document.bindings.strategyProtocolHash,
    })),
  }
  expect(registeredDecisionWork(document, samePolicy)?.correct).toBe(true)
  const samePolicyCut = { ...cut, registrationHash: testHash(samePolicy) }
  expect(
    Result.getOrThrow(bindOperationalObligations(samePolicyCut, samePolicy, testHash(samePolicyCut))).reliability
      .completions,
  ).toHaveLength(1)
})
