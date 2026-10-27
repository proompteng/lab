import { beforeAll, describe, expect, test } from 'bun:test'
import { Effect, Result } from 'effect'
import { nativeJevDecisionEvidence, nativeJevFixture } from '../jev/native.test-support'
import { matchedCommittedDecisionFixture } from '../intraday-replay/matched-entry.test-support'
import { nativeEntryTimingFixture } from '../intraday-replay/entry-timing.test-support'
import { supportedAssessmentFixture, testHash } from './fixtures.test-support'
import { bindEntryTimings } from './entry-timing'
import type { SystemSourceCut } from './source-cut'
import { JevResearchPolicy } from '../jev/acceptance'

let fixture: ReturnType<typeof nativeEntryTimingFixture>
beforeAll(async () => {
  const native = nativeJevFixture()
  const document = await Effect.runPromise(matchedCommittedDecisionFixture(native, nativeJevDecisionEvidence(native)))
  fixture = nativeEntryTimingFixture(document)
})
const evidence = () => {
  const { input } = supportedAssessmentFixture()
  const candidate = input.registration.policies.find((p) => p.policy === 'JEV')
  if (candidate === undefined) throw new Error('Missing candidate')
  const bytes = fixture.input()
  const cut: SystemSourceCut = {
    schemaVersion: 'bayn.system-source-cut.v2',
    orders: [],
    registrationHash: testHash(input.registration),
    asOf: input.asOf,
    runtimeConfigurationHash: input.registration.obligations.runtimeConfigurationHash,
    financial: [
      {
        policy: JevResearchPolicy.Candidate,
        sourceHash: testHash('financial'),
        accountBindingHash: candidate.accountBindingHash,
        definitionHash: testHash(candidate),
        cashHistory: null,
        sessions: [],
      },
    ],
    inference: [],
    inferenceLedgerEvidenceHash: testHash('inference'),
    decisions: [{ sessionDate: '2026-11-02', document: fixture.decision }],
    batches: [],
    mutations: [],
    fills: [],
    accountMarks: [],
    controllerPasses: [],
    durableObservations: [],
    sourceMaterial: {},
    sourceMaterialHash: testHash({}),
  }
  const sources = [
    {
      decisionHash: fixture.decision.contentHash,
      traceHash: bytes.traceSha256,
      decisionFileHash: bytes.decisionSha256,
    },
  ]
  const artifacts = new Map([
    [bytes.traceSha256, bytes.traceBytes],
    [bytes.decisionSha256, bytes.decisionBytes],
  ])
  return { bytes, cut, sources, artifacts }
}

describe('assessment native commit timing', () => {
  test('reproduces the actual decision and COMMIT ACK upper bound from the original trace bytes', () => {
    const { bytes, cut, sources, artifacts } = evidence()
    const timings = Result.getOrThrow(bindEntryTimings(sources, cut, bytes.sourceRevision, artifacts))
    expect(timings).toHaveLength(1)
    expect(timings[0]?.timing.decisionHash).toBe(fixture.decision.contentHash)
    expect(timings[0]?.timing.decisionCommittedAt).toBe(
      new Date(Number(fixture.commitNanos / 1000000n + 1n)).toISOString(),
    )
  })
  test('rejects a missing source, altered bytes, foreign revision, duplicate receipt and future commit', () => {
    const { bytes, cut, sources, artifacts } = evidence()
    const altered = new Map(artifacts)
    altered.set(bytes.traceSha256, new TextEncoder().encode('{}'))
    for (const candidate of [new Map<string, Uint8Array>(), altered])
      expect(Result.isFailure(bindEntryTimings(sources, cut, bytes.sourceRevision, candidate))).toBe(true)
    expect(Result.isFailure(bindEntryTimings(sources, cut, 'b'.repeat(40), artifacts))).toBe(true)
    expect(Result.isFailure(bindEntryTimings([...sources, ...sources], cut, bytes.sourceRevision, artifacts))).toBe(
      true,
    )
    expect(
      Result.isFailure(
        bindEntryTimings(sources, { ...cut, asOf: fixture.decision.createdAt }, bytes.sourceRevision, artifacts),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(bindEntryTimings(sources, { ...cut, decisions: [] }, bytes.sourceRevision, artifacts)),
    ).toBe(true)
  })
})
