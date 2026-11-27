import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { preparedReplayAlphaObservationFixture } from '../intraday-replay/alpha-prepared-baseline.test-support'
import { BacktestIssue, prepareBacktest } from '../intraday-replay/backtest'
import { JevResearchPolicy } from '../jev/acceptance'
import { reproduceAlphaBaselinePreparation } from '../observe-composition/alpha-baseline-preparation'
import { nativeAlphaDecisionFixture } from '../strategy/intraday-alpha/alpha-decision.test-support'
import { makeOwnedIntradayAlphaObservation } from '../strategy/intraday-alpha/observation'
import { makeAlphaStreamingSnapshot, makeFlatAlphaPortfolio } from '../strategy/intraday-alpha/test-support'
import { testHash } from './fixtures.test-support'
import { preparedAlphaReportFixture } from './prepared-alpha-report.test-support'
import { StrategyBoundSystemSourceCutSchema } from './source-cut'
import { ResearchStrategyEngine } from './strategy-binding'

const valid = (fixture: ReturnType<typeof preparedAlphaReportFixture>, report: unknown = fixture.report) =>
  Result.getOrThrowWith(fixture.bind(report), (cause) => new Error(JSON.stringify(cause)))

const reportTest = (name: string, run: () => void | Promise<void>) => test(name, run, 60000)

reportTest(
  'v11 prepared alpha report binds its full source and genuine four-leg decision without self-attesting economics',
  async () => {
    const f = preparedAlphaReportFixture()
    const verified = valid(f)
    expect(verified).toHaveLength(1)
    expect(verified[0]?.economics).toBeNull()
    expect(f.input.schemaVersion).toBe('bayn.backtest.v13')
    expect(f.report.schemaVersion).toBe('bayn.backtest-report.v11')
    const native = await nativeAlphaDecisionFixture({
      accountId: `replay-${f.report.runId}`,
      calendar: f.calendar,
      baselinePreparation: f.record,
    })
    const target = native.document.strategyDecision
    if (target?.schemaVersion !== 'bayn.intraday-alpha-target.v2') throw new Error('Missing genuine alpha target')
    expect(native.document.targetPlan.intentTargets).toHaveLength(4)
    const observation = target.evidence.observation
    const row = preparedReplayAlphaObservationFixture(
      { contentHash: testHash(observation), payload: observation },
      f.baseline,
    )
    const report = {
      ...f.report,
      alphaObservations: [row],
      decisions: [native.document],
      latencyStress: {
        ...f.report.latencyStress,
        observationReceipts: [f.receiptFor(row, 100)],
      },
    }
    expect(valid(f, report)[0]?.economics).toBeNull()
    expect(Result.isFailure(f.bind({ ...report, decisions: [{}] }))).toBe(true)
  },
)

reportTest('prepared alpha report rejects cross-version registration, cut, input and report substitutions', () => {
  const f = preparedAlphaReportFixture()
  const { alphaBaselinePreparations: _preparations, ...priorCut } = f.cut
  const retainedCut = Schema.decodeUnknownSync(StrategyBoundSystemSourceCutSchema)({
    ...priorCut,
    schemaVersion: 'bayn.system-source-cut.v5',
    durableObservations: priorCut.durableObservations.filter((row) => row.kind !== 'ALPHA_BASELINE'),
  })
  for (const version of ['bayn.backtest-report.v9', 'bayn.backtest-report.v10'])
    expect(Result.isFailure(f.bind({ ...f.report, schemaVersion: version }))).toBe(true)
  expect(Result.isFailure(f.bind(f.report, { input: { ...f.input, schemaVersion: 'bayn.backtest.v12' } }))).toBe(true)
  expect(Result.isFailure(f.bind(f.report, { cut: retainedCut }))).toBe(true)
  expect(
    Result.isFailure(
      f.bind(f.report, { registration: { ...f.registration, schemaVersion: 'bayn.system-registration.v6' } }),
    ),
  ).toBe(true)
})

reportTest(
  'registered preparation rejects another producer account, generation, source revision or physical image',
  () => {
    for (const change of [
      { accountId: 'another-producer-account' },
      { authorityGenerationHash: testHash('another-producer-generation') },
      { executionBuild: { sourceRevision: '1'.repeat(40) } },
      { executionBuild: { imageDigest: `sha256:${testHash('another-producer-image')}` } },
    ]) {
      expect(() =>
        preparedAlphaReportFixture({
          changeRecord: (record) => {
            const { executionBuild, ...fields } = change
            const reproduced = Result.getOrThrow(
              reproduceAlphaBaselinePreparation({
                ...record.payload,
                ...fields,
                executionBuild: { ...record.payload.executionBuild, ...executionBuild },
              }),
            )
            return { ...record, contentHash: reproduced.contentHash, payload: reproduced.payload }
          },
        }),
      ).toThrow(/Registered alpha preparation capture is invalid/)
    }
  },
)

reportTest('prepared alpha report requires exact source, witness, full policy and command ownership', () => {
  const f = preparedAlphaReportFixture()
  const row = f.report.alphaObservations[0]
  if (row === undefined) throw new Error('Missing prepared alpha observation')
  for (const change of [
    { sourcePreparationHash: testHash('unretained preparation') },
    { sourceWitnessHash: testHash('another registration witness') },
    { baselineHash: testHash('different baseline') },
    { cycleId: testHash('different cycle') },
    { authorityGenerationHash: testHash('different authority') },
    { admissionExpiresAt: row.payload.observedAt },
    { commandIssuedAt: f.at(1) },
  ])
    expect(
      Result.isFailure(
        f.bind({
          ...f.report,
          alphaObservations: [{ ...row, baselineUse: { ...row.baselineUse, ...change } }],
        }),
      ),
    ).toBe(true)
  const changedPolicy = {
    ...f.record.payload,
    policy: {
      ...f.record.payload.policy,
      sharedProtocol: {
        ...f.record.payload.policy.sharedProtocol,
        maximumQuoteAgeMs: f.record.payload.policy.sharedProtocol.maximumQuoteAgeMs + 1,
      },
    },
  }
  expect(Result.isFailure(reproduceAlphaBaselinePreparation(changedPolicy))).toBe(true)
  expect(
    Result.isFailure(
      prepareBacktest(
        {
          ...f.input,
          alphaBaselinePreparations: [
            { ...f.baseline, preparationHash: testHash(changedPolicy), payload: changedPolicy },
          ],
        },
        f.capture,
      ),
    ),
  ).toBe(true)
  for (const input of [
    { ...f.input, alphaBaselinePreparations: [] },
    { ...f.input, alphaBaselinePreparations: [f.baseline, f.baseline] },
    { ...f.input, alphaBaselinePreparations: [{ ...f.baseline, witnessSourceHash: testHash('different witness') }] },
  ])
    expect(Result.isFailure(f.bind(f.report, { input }))).toBe(true)
})

reportTest('a witness arriving between command and admission cannot rescue the original replay command', () => {
  const f = preparedAlphaReportFixture({ availableAt: '2026-09-04T14:31:02.000Z' })
  expect(valid(f)).toHaveLength(1)
  const row = f.report.alphaObservations[0]
  if (row === undefined) throw new Error('Missing prepared alpha observation')
  expect(row.baselineUse.commandIssuedAt).toBe(f.baseline.availableAt)
  const commandIssuedAt = f.at(-1)
  const earlier = { ...row, baselineUse: { ...row.baselineUse, commandIssuedAt } }
  expect(
    commandIssuedAt < f.baseline.availableAt && f.baseline.availableAt <= row.baselineUse.admissionObservedAt,
  ).toBe(true)
  expect(
    Result.isFailure(
      f.bind({
        ...f.report,
        alphaObservations: [earlier],
        latencyStress: {
          ...f.report.latencyStress,
          observationReceipts: [f.receiptFor(earlier)],
        },
      }),
    ),
  ).toBe(true)
})

reportTest('a missing first prepared command remains incomplete after later valid observations', () => {
  const f = preparedAlphaReportFixture({ availableAt: '2026-09-04T13:31:02.001Z' })
  const gap = {
    reason: 'MISSING_CAUSAL_ALPHA_BASELINE' as const,
    sessionDate: f.record.payload.sessionDate,
    observedAt: '2026-09-04T13:31:02.000Z',
    firstAvailableAt: f.baseline.availableAt,
  }
  const incomplete = {
    ...f.report,
    completion: 'INCOMPLETE',
    issues: [BacktestIssue.MissingCausalAlphaBaseline],
    alphaBaselineGaps: [gap],
  }
  expect(valid(f, incomplete)[0]?.economics).toBeNull()
  expect(incomplete.alphaObservations).toHaveLength(1)
  expect(incomplete.sessionDates).toEqual(f.registration.calendar.sessions.map((session) => session.sessionDate))
  for (const report of [
    { ...incomplete, completion: 'COMPLETE' },
    { ...incomplete, alphaBaselineGaps: [] },
    { ...incomplete, issues: [] },
    { ...incomplete, alphaBaselineGaps: [{ ...gap, observedAt: f.baseline.availableAt }] },
  ])
    expect(Result.isFailure(f.bind(report))).toBe(true)
})

reportTest(
  'alpha incumbent reuses matching market preparation without relabeling candidate producer or borrowing its account',
  () => {
    const f = preparedAlphaReportFixture({ policy: JevResearchPolicy.Incumbent })
    expect(valid(f)).toHaveLength(1)
    expect(f.candidate.riskPolicy.accountId).not.toBe(f.definition.riskPolicy.accountId)
    expect(f.record.payload.accountId).toBe(f.candidate.riskPolicy.accountId)
    expect(f.record.payload.authorityGenerationHash).toBe(f.candidate.authorityGenerationHash)
    expect(f.baseline.payload.executionBuild.sourceRevision).toBe(f.candidate.sourceRevision)
    expect(f.baseline.payload.executionBuild.imageDigest).toBe(`sha256:${f.candidate.imageDigest}`)
    if (f.definition.strategyBinding.engine !== ResearchStrategyEngine.IntradayAlpha)
      throw new Error('Missing alpha incumbent binding')
    expect(f.baseline.payload.policy).toEqual(f.definition.strategyBinding.parameters)
    const snapshot = makeAlphaStreamingSnapshot({
      minutesFromOpen: 61,
      profiles: {},
      snapshotCalendar: f.calendar,
    })
    const foreign = Result.getOrThrow(
      makeOwnedIntradayAlphaObservation({
        cycleId: f.observation.payload.cycleId,
        authorityGenerationHash: f.observation.payload.authorityGenerationHash,
        protocol: f.registration.obligations.configuration.protocol,
        portfolio: makeFlatAlphaPortfolio(snapshot.observedAt, undefined, undefined, f.record.payload.accountId),
        snapshot: snapshot.snapshot,
        trailingBaseline: f.baseline.payload.acquisition.trailingBaseline,
      }),
    )
    const row = preparedReplayAlphaObservationFixture(foreign, f.baseline)
    expect(
      Result.isFailure(
        f.bind({
          ...f.report,
          alphaObservations: [row],
          latencyStress: {
            ...f.report.latencyStress,
            observationReceipts: f.report.latencyStress.observationReceipts.map((receipt) => ({
              ...receipt,
              observationHash: row.contentHash,
            })),
          },
        }),
      ),
    ).toBe(true)
  },
)

reportTest('prepared report preserves exact observed and release inventories and actual zero provider calls', () => {
  const f = preparedAlphaReportFixture()
  const row = f.report.alphaObservations[0]
  const receipt = f.report.latencyStress.observationReceipts[0]
  if (row === undefined || receipt === undefined) throw new Error('Missing alpha report inventory')
  for (const report of [
    { ...f.report, alphaObservations: [] },
    { ...f.report, alphaObservations: [row, row] },
    { ...f.report, inference: { ...f.report.inference, providerDispatchCount: 1 } },
    { ...f.report, latencyStress: { ...f.report.latencyStress, observationReceipts: [receipt, receipt] } },
    {
      ...f.report,
      latencyStress: {
        ...f.report.latencyStress,
        observationReceipts: [{ ...receipt, observationHash: testHash('orphan command') }],
      },
    },
  ])
    expect(Result.isFailure(f.bind(report))).toBe(true)
})
