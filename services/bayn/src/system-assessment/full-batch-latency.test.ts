import { makeJevObservation } from '../jev/observation'
import { completeLatencyArtifactFixture } from './latency-report.test-support'
import { beforeAll, describe, expect, test } from 'bun:test'
import { Effect, Result, Schema } from 'effect'

import { MutationEventType } from '../execution/mutations/model'
import { makeJevBatchResult } from '../jev/batch'
import { decideJevEntry } from '../jev/decision'
import { nativeJevDecisionEvidence, nativeJevFixture } from '../jev/native.test-support'
import type { ExecutionDecisionDocument } from '../shadow-decision-contract'
import { ControllerPassEvidenceSchema } from './decision-work'
import { fullBatchClockDuration } from './full-batch-latency'
import { SystemSourceCutSchema } from './source-cut'
import { prepareSystemLatencyReplay } from './latency-replay'
import { BacktestIssue } from '../intraday-replay/backtest'
import { JevResearchPolicy } from '../jev/acceptance'
import { bindLatencyStressSources } from './latency-report'
import { testHash } from './fixtures.test-support'
import {
  fullBatchLatencyFixture,
  latencyCalibrationDecisionFixture,
  nativeLatencyBacktestFixture,
} from './latency.test-support'

let document: ExecutionDecisionDocument
let native: ReturnType<typeof nativeJevFixture>
beforeAll(async () => {
  const result = await Effect.runPromise(latencyCalibrationDecisionFixture)
  native = result.native
  document = result.document
})

const fixture = () => fullBatchLatencyFixture(document, native)

describe('source-bound full batch timing', () => {
  test('ablation stress binds its own economic account and policy under the shared calibrated floor', () => {
    const replay = nativeLatencyBacktestFixture(fixture(), undefined, JevResearchPolicy.Ablation)
    const artifact = completeLatencyArtifactFixture(replay)
    const verify = (descriptor = artifact.descriptor) =>
      bindLatencyStressSources([descriptor], replay.registration, replay.cut, artifact.artifacts, artifact.sources)
    const receipt = Result.getOrThrowWith(verify(), (cause) => cause)[0]
    expect(receipt?.policy).toBe(JevResearchPolicy.Ablation)
    expect(receipt?.economics).toBeNull()
    expect(replay.prepared.strategy.definition.parameters.schemaVersion).toBe('bayn.entry-ablation-policy.v1')
    expect(replay.prepared.latencyStress?.protocol.controlIntervention).toBe(
      'SAME_CALIBRATED_FLOOR_WITH_OWN_ACTUAL_COMPLETION',
    )
    const account = replay.registration.policies.find(
      (p) => p.policy === JevResearchPolicy.Ablation,
    )?.accountBindingHash
    expect(artifact.costs.sessions.every((session) => session.accountBindingHash === account)).toBe(true)
    expect(account).not.toBe(
      replay.cut.financial.find((p) => p.policy === JevResearchPolicy.Candidate)?.accountBindingHash,
    )
    expect(Result.isFailure(verify({ ...artifact.descriptor, policy: JevResearchPolicy.Candidate }))).toBe(true)
    const changed = { ...artifact.costs, policy: JevResearchPolicy.Candidate }
    const changedHash = artifact.retain(changed)
    artifact.sources.add(changedHash)
    expect(Result.isFailure(verify({ ...artifact.descriptor, costsFileHash: changedHash }))).toBe(true)
    const batch = replay.cut.batches[0]
    if (batch === undefined) throw new Error('Missing candidate calibration batch')
    const report = {
      ...artifact.report,
      completion: 'INCOMPLETE',
      issues: [BacktestIssue.UnreleasedLatencyBatch],
      batches: [{ plan: batch.plan, result: null }],
      latencyStress: {
        ...artifact.report.latencyStress,
        admittedBatchCount: 1,
        unreleasedBatchIds: [batch.plan.batchId],
      },
    }
    const reportFileHash = artifact.retain({ ...report, reportHash: testHash(report) })
    artifact.sources.add(reportFileHash)
    const rejected = verify({ ...artifact.descriptor, reportFileHash })
    expect(Result.isFailure(rejected)).toBe(true)
    if (Result.isFailure(rejected))
      expect(String(rejected.failure.cause)).toContain('Latency batch differs from the registered replay policy')
  }, 60000)

  test('momentum stress binds every committed observation to its account, clock and source without inference', () => {
    const replay = nativeLatencyBacktestFixture(fixture(), undefined, JevResearchPolicy.Momentum)
    const artifact = completeLatencyArtifactFixture(replay)
    const original = replay.cut.batches[0]?.observation
    const stress = replay.prepared.latencyStress
    if (original === undefined || original === null || stress === null) throw new Error('Missing native source')
    const source = nativeJevFixture(
      undefined,
      original.observedAt,
      `replay-${replay.prepared.runId}`,
      original.protocol,
    )
    const payload = Result.getOrThrow(makeJevObservation({ ...source.input, snapshot: source.snapshot })).payload
    const hash = testHash(payload)
    const issued = new Date(Date.parse(payload.observedAt) - 10).toISOString()
    const completed = new Date(Date.parse(payload.observedAt) + 5).toISOString()
    const floor = new Date(Date.parse(issued) + stress.p95FullBatchMs).toISOString()
    const released = new Date(Math.max(Date.parse(completed), Date.parse(floor))).toISOString()
    const receipt = {
      observationHash: hash,
      commandIssuedAt: issued,
      observedAt: payload.observedAt,
      completedAt: completed,
      releaseFloorAt: floor,
      releasedAt: released,
    }
    const report = {
      ...artifact.report,
      momentumObservations: [{ contentHash: hash, payload }],
      latencyStress: { ...artifact.report.latencyStress, admittedObservationCount: 1, observationReceipts: [receipt] },
    }
    const verify = (candidate: unknown) => {
      const record = { ...report, ...(typeof candidate === 'object' && candidate !== null ? candidate : {}) }
      const reportFileHash = artifact.retain({ ...record, reportHash: testHash(record) })
      artifact.sources.add(reportFileHash)
      return bindLatencyStressSources(
        [{ ...artifact.descriptor, reportFileHash }],
        replay.registration,
        replay.cut,
        artifact.artifacts,
        artifact.sources,
      )
    }
    Result.getOrThrowWith(verify(report), (cause) => new Error(String(cause.cause)))
    expect(replay.prepared.policyIdentity.planVersion).toBeNull()
    expect(replay.prepared.strategy.definition.parameters.schemaVersion).toBe('bayn.repeated-momentum-policy.v1')
    for (const changed of [
      { momentumObservations: [] },
      { momentumObservations: [...report.momentumObservations, ...report.momentumObservations] },
      { momentumObservations: [{ contentHash: testHash('substitute'), payload }] },
      ...[
        { observationReceipts: [] },
        { observationReceipts: [receipt, receipt] },
        { admittedObservationCount: 0 },
        { unreleasedObservationHashes: [hash] },
        { observationReceipts: [{ ...receipt, observationHash: testHash('other source') }] },
        { observationReceipts: [{ ...receipt, releaseFloorAt: issued }] },
        { observationReceipts: [{ ...receipt, releasedAt: issued }] },
        { observationReceipts: [{ ...receipt, commandIssuedAt: completed }] },
        { observationReceipts: [{ ...receipt, completedAt: issued }] },
        { observationReceipts: [{ ...receipt, observedAt: issued }] },
      ].map((changed) => ({ latencyStress: { ...report.latencyStress, ...changed } })),
    ])
      expect(Result.isFailure(verify(changed))).toBe(true)
    const incomplete = {
      ...report,
      completion: 'INCOMPLETE',
      issues: [BacktestIssue.UnreleasedLatencyObservation],
      latencyStress: { ...report.latencyStress, observationReceipts: [], unreleasedObservationHashes: [hash] },
    }
    const retained = Result.getOrThrowWith(verify(incomplete), (cause) => cause)
    expect(retained[0]?.economics).toBeNull()
  }, 180000)

  test('assessment reproduces complete replay accounting and rejects altered scope, costs, releases and artifact bytes', () => {
    const f = fixture()
    const { input, prepared, registration, cut, capture, source, first, last } = nativeLatencyBacktestFixture(f)
    const stress = prepared.latencyStress
    const definition = registration.policies.find((p) => p.policy === JevResearchPolicy.Candidate)
    if (stress === null || definition === undefined) throw new Error('Missing stress preparation')
    const { checkpoint, report, artifacts, retain, descriptor, sources } = completeLatencyArtifactFixture({
      input,
      prepared,
      registration,
      cut,
      capture,
      source,
      first,
      last,
    })
    expect(descriptor.captureFileHash).toBe(capture.contentHash)
    const verify = (overrides: Partial<typeof descriptor> = {}) =>
      bindLatencyStressSources([{ ...descriptor, ...overrides }], registration, cut, artifacts, sources)
    const receipt = Result.getOrThrowWith(verify(), (cause) => cause)[0]
    expect(receipt?.image).toBeNull()
    expect(receipt?.economics).toBeNull()
    for (const altered of [
      { ...report, runId: testHash('other run') },
      { ...report, sessions: [] },
      { ...report, sessions: report.sessions.slice(1) },
      { ...report, sessions: report.sessions.toReversed() },
      { ...report, sessionDates: report.sessionDates.slice(1) },
      { ...report, sessions: report.sessions.map((s) => ({ ...s, sessionDate: first.sessionDate })) },
      ...report.sessions.slice(0, 1).flatMap((s) =>
        [
          { ...s, schedule: { ...s.schedule, passCount: 0 } },
          { ...s, schedule: { ...s.schedule, failedPassCount: 1 } },
          { ...s, schedule: { ...s.schedule, unavailableDecisionPassCount: 1 } },
          { ...s, schedule: { ...s.schedule, lastPollAtMs: Date.parse(first.closeAt) - 1 } },
          { ...s, schedule: { ...s.schedule, firstPollAtMs: Date.parse(first.closeAt) + 1 } },
          { ...s, valuationFailureCount: 1 },
          { ...s, closingEquity: { ...s.closingEquity, valuationQualified: false } },
          { ...s, closingEquity: { ...s.closingEquity, equityMicros: '900000000000' } },
          { ...s, closingEquity: { ...s.closingEquity, openOrderCount: 1 } },
          { ...s, remainingPositions: [{}] },
          { ...s, allocatedDataCostMicros: null },
          {
            ...s,
            reconciliation: { ...s.reconciliation, brokerState: { unknownOrderCount: 1 } },
          },
        ].map((session) => ({ ...report, sessions: [session, ...report.sessions.slice(1)] })),
      ),
      { ...report, comparisonInputHash: testHash('changed input') },
      { ...report, inference: { ...report.inference, providerDispatchCount: 1 } },
      { ...report, latencyStress: { ...report.latencyStress, admittedBatchCount: 1 } },
      { ...report, latencyStress: { ...report.latencyStress, calibration: {} } },
      {
        ...report,
        brokerCheckpoint: {
          ...checkpoint,
          state: { ...checkpoint.state, ledger: { ...checkpoint.state.ledger, cashMicros: '900000000000' } },
        },
      },
    ]) {
      const reportFileHash = retain({ ...altered, reportHash: testHash(altered) })
      sources.add(reportFileHash)
      expect(Result.isFailure(verify({ reportFileHash }))).toBe(true)
    }
    const incomplete = { ...report, completion: 'INCOMPLETE' }
    const reportFileHash = retain({ ...incomplete, reportHash: testHash(incomplete) })
    sources.add(reportFileHash)
    expect(Result.getOrThrow(verify({ reportFileHash }))[0]?.economics).toBeNull()
    const failedSessionReport = {
      ...report,
      sessions: report.sessions.map((s, index) =>
        index === 0
          ? {
              ...s,
              completion: 'INCOMPLETE',
              issues: [BacktestIssue.MissingDecisionData],
              schedule: { ...s.schedule, unavailableDecisionPassCount: 1 },
            }
          : s,
      ),
    }
    for (const completion of ['COMPLETE', 'INCOMPLETE']) {
      const material = { ...failedSessionReport, completion }
      const reportFileHash = retain({ ...material, reportHash: testHash(material) })
      sources.add(reportFileHash)
      const result = verify({ reportFileHash })
      if (completion === 'COMPLETE') expect(Result.isFailure(result)).toBe(true)
      else expect(Result.getOrThrowWith(result, (cause) => cause)[0]?.economics).toBeNull()
    }
    const batch = cut.batches[0]
    const commandIssuedAt = f.batchPass.observation.executionIssuedAt
    if (batch?.result === null || batch === undefined || commandIssuedAt === undefined)
      throw new Error('Missing complete batch')
    const releaseFloorAt = new Date(Date.parse(commandIssuedAt) + stress.p95FullBatchMs).toISOString()
    const releasedAt = releaseFloorAt > batch.result.completedAt ? releaseFloorAt : batch.result.completedAt
    const omittedCalls = {
      ...report,
      batches: [{ plan: batch.plan, result: batch.result }],
      latencyStress: {
        ...report.latencyStress,
        admittedBatchCount: 1,
        receipts: [
          {
            batchId: batch.plan.batchId,
            resultHash: batch.result.resultHash,
            commandIssuedAt,
            batchObservedAt: batch.plan.observedAt,
            completedAt: batch.result.completedAt,
            releaseFloorAt,
            releasedAt,
          },
        ],
      },
    }
    const omittedHash = retain({ ...omittedCalls, reportHash: testHash(omittedCalls) })
    sources.add(omittedHash)
    const omitted = verify({ reportFileHash: omittedHash })
    expect(Result.isFailure(omitted)).toBe(true)
    if (Result.isFailure(omitted))
      expect(String(omitted.failure.cause)).toContain('Latency report omitted or substituted a charged chart inference')
    artifacts.set(descriptor.reportFileHash, new TextEncoder().encode('{}'))
    expect(Result.isFailure(verify())).toBe(true)
  }, 180000)

  test('latency replay reproduces complete calibration and refuses missing or changed evidence', () => {
    const { cut, registration, identity, measure } = fixture()
    const input = { registration, brokerIdentity: identity, sourceCut: cut }
    const prepared = Result.getOrThrow(prepareSystemLatencyReplay(input))
    expect(prepared.calibration).toEqual(measure())
    expect(measure().p95FullBatchMs).toBe(prepared.p95FullBatchMs)
    expect(
      Result.isFailure(
        prepareSystemLatencyReplay({ ...input, sourceCut: { ...cut, sourceMaterial: { changed: true } } }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(prepareSystemLatencyReplay({ ...input, sourceCut: { ...cut, durableObservations: [] } })),
    ).toBe(true)
    expect(
      Result.isFailure(
        prepareSystemLatencyReplay({
          ...input,
          registration: { ...registration, latencyStressProtocolHash: testHash('different protocol') },
        }),
      ),
    ).toBe(true)
  })
  test('includes inference, persistence, routing and uncertainty recovery from the original command', () => {
    const { cut, measure, at, batchPass } = fixture()
    const report = measure()
    expect(report).toMatchObject({
      status: 'MEASURED',
      admittedBatchCount: 1,
      measuredBatchCount: 1,
      missing: [],
      violations: [],
    })
    expect(report.samples[0]).toMatchObject({
      startedAt: batchPass.observation.executionIssuedAt,
      completedAt: at(1100),
      decisionHashes: [document.contentHash],
      mutationIds: document.orderedIntentIds.map((intentId) => testHash({ intentId })),
    })
    expect(report.p95FullBatchMs).toBe(Date.parse(at(1100)) - Date.parse(batchPass.observation.executionIssuedAt ?? ''))
    expect(measure({ ...cut, batches: [...cut.batches, ...cut.batches] }).samples).toEqual(report.samples)
  })

  test('unresolved submissions, unfinished inference, missing witnesses and missing commands withhold the percentile', () => {
    const { cut, measure } = fixture()
    for (const source of [
      { ...cut, mutations: cut.mutations.filter(({ event }) => event.eventType !== MutationEventType.RecoveryFound) },
      { ...cut, mutations: [] },
      { ...cut, batches: cut.batches.map((batch) => ({ ...batch, result: null })) },
      { ...cut, batches: [] },
      { ...cut, controllerPasses: cut.controllerPasses.slice(1) },
      { ...cut, controllerPasses: cut.controllerPasses.slice(0, -1) },
      {
        ...cut,
        controllerPasses: cut.controllerPasses.map((pass) => ({
          ...pass,
          observation: { ...pass.observation, jevObservationReferences: { hashes: [], complete: false } },
        })),
      },
      { ...cut, durableObservations: cut.durableObservations.filter((w) => w.kind !== 'BATCH') },
      { ...cut, durableObservations: cut.durableObservations.filter((w) => w.kind !== 'MUTATION') },
      { ...cut, decisions: [] },
    ]) {
      const report = measure(source)
      expect(report.status).toBe('INCOMPLETE')
      expect(report.p95FullBatchMs).toBeNull()
    }
  })

  test('a delayed durable recovery witness cannot make the batch appear faster', () => {
    const { cut, measure } = fixture()
    const source = cut.mutations.find(({ event }) => event.eventType === MutationEventType.RecoveryFound)?.event.eventId
    const delayed = measure({
      ...cut,
      durableObservations: cut.durableObservations.map((witness) =>
        witness.sourceHash === source
          ? { ...witness, witnessedAt: new Date(Date.parse(witness.witnessedAt) + 5000).toISOString() }
          : witness,
      ),
    })
    expect(delayed.status).toBe('MEASURED')
    expect(delayed.p95FullBatchMs).toBe((measure().p95FullBatchMs ?? 0) + 5000)
  })

  test('empty, invalid and reversed stage clocks never yield a duration', () => {
    const instant = (ms: number) => new Date(ms).toISOString()
    const ordered = {
      issuedAt: instant(1),
      observedAt: instant(2),
      batchCompletedAt: instant(3),
      durableCompletions: [instant(4), instant(100), instant(5)],
    }
    expect(fullBatchClockDuration(ordered)).toBe(99)
    for (const clock of [
      { ...ordered, durableCompletions: [] },
      { ...ordered, durableCompletions: ['invalid'] },
      { ...ordered, durableCompletions: [instant(2)] },
      { ...ordered, issuedAt: instant(4) },
      { ...ordered, observedAt: 'invalid' },
    ])
      expect(fullBatchClockDuration(clock)).toBeUndefined()
  })

  test('rejects altered source material, foreign decisions, missing event sequence and reversed routing clocks', () => {
    const { cut, measure, at } = fixture()
    for (const source of [
      { ...cut, batches: cut.batches.map((batch) => ({ ...batch, plan: { ...batch.plan, expiresAt: at(8000) } })) },
      {
        ...cut,
        batches: cut.batches.map((batch) => ({
          ...batch,
          observation:
            batch.observation === null ? null : { ...batch.observation, authorityGenerationHash: testHash('foreign') },
        })),
      },
      { ...cut, mutations: cut.mutations.map((m) => ({ ...m, strategyDecisionHash: document.contentHash })) },
      { ...cut, mutations: cut.mutations.filter(({ event }) => event.sequence !== 2) },
      {
        ...cut,
        mutations: cut.mutations.map((m) => ({
          ...m,
          event: {
            ...m.event,
            ...(m.event.routing === undefined ? {} : { routing: { ...m.event.routing, startedAt: at(50) } }),
          },
        })),
      },
    ]) {
      const report = measure(source)
      expect(report.status).toBe('VIOLATED')
      expect(report.p95FullBatchMs).toBeNull()
    }
  })

  test('an expired abandoned batch remains a measured failure without inventing a trade', () => {
    const { cut, measure, witness, batchPass } = fixture()
    const batch = cut.batches[0]
    if (batch === undefined) throw new Error('Missing batch')
    const result = Result.getOrThrow(
      makeJevBatchResult(batch.plan, {
        schemaVersion: 'bayn.jev-batch-result.v1',
        batchId: batch.plan.batchId,
        completedAt: batch.plan.expiresAt,
        candidates: batch.plan.candidates.map((candidate) =>
          candidate.status === 'EXCLUDED'
            ? { symbol: candidate.symbol, status: 'EXCLUDED' }
            : { symbol: candidate.symbol, status: 'UNATTEMPTED', requestId: candidate.request.requestId },
        ),
      }),
    )
    const recovery = {
      ...batchPass,
      receiptHash: testHash('abandoned-recovery'),
      sequence: 999,
      completedAt: batch.plan.expiresAt,
      observation: { ...batchPass.observation, observedAt: batch.plan.expiresAt },
    }
    const report = measure({
      ...cut,
      batches: [{ ...batch, result }],
      decisions: [],
      mutations: [],
      controllerPasses: [...cut.controllerPasses, recovery],
      durableObservations: [
        ...cut.durableObservations,
        witness('BATCH', result.resultHash, result.completedAt),
        witness('CONTROLLER', recovery.receiptHash, recovery.completedAt),
      ],
    })
    expect(report).toMatchObject({ status: 'MEASURED', measuredBatchCount: 1, missing: [], violations: [] })
    expect(report.samples[0]).toMatchObject({ failed: true, expired: true, decisionHashes: [], mutationIds: [] })
    expect(report.p95FullBatchMs).toBeGreaterThan(1000)
  })

  test('a completed strategy abstention is measured without creating a submission', () => {
    const { cut, measure, witness, batchPass } = fixture()
    const evidence = nativeJevDecisionEvidence(native, false)
    const target = Result.getOrThrow(decideJevEntry(evidence))
    expect(target.selectedSymbols).toEqual([])
    const abstention = Schema.decodeUnknownSync(ControllerPassEvidenceSchema)({
      ...batchPass,
      observation: {
        ...batchPass.observation,
        outcome: 'RECOVERED',
        recoveryAction: 'WAITING',
        readiness: { reason: 'NO_ELIGIBLE_CANDIDATE', message: 'No supported entries' },
        entryAbstention: target,
      },
    })
    const report = measure({
      ...cut,
      decisions: [],
      mutations: [],
      batches: [
        {
          plan: evidence.batchPlan,
          observation: Schema.decodeUnknownSync(SystemSourceCutSchema.fields.batches.value.fields.observation)(
            evidence.observation,
          ),
          result: evidence.batchResult,
        },
      ],
      controllerPasses: [abstention, ...cut.controllerPasses.slice(1)],
      durableObservations: [
        ...cut.durableObservations,
        witness('BATCH', evidence.batchResult.resultHash, evidence.batchResult.completedAt),
      ],
    })
    expect(report).toMatchObject({ status: 'MEASURED', measuredBatchCount: 1, missing: [], violations: [] })
    expect(report.samples[0]).toMatchObject({
      abstained: true,
      failed: false,
      expired: false,
      decisionHashes: [],
      mutationIds: [],
    })
  })
})
