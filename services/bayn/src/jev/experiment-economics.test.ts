import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Result, Schema } from 'effect'
import { IsoDateSchema } from '../schemas'
import type { ReplayBrokerFill } from '../intraday-replay/broker'

import { canonicalHashV1Result, sha256 } from '../hash'
import { jevEvaluationCommand } from '../jev-evaluation-command'
import { JevFailure, jevModel } from './contract'
import { calculateReplayJevCosts } from '../intraday-replay/jev-costs'
import { applyReplayFill, createReplayLedger } from '../intraday-replay/ledger'
import { retainedReplayFixture } from '../testing/retained-replay-fixture'
import { BacktestComparisonInputSchema, BacktestIssue } from '../intraday-replay/backtest'
import { replayTestInstruments } from '../testing/replay-instruments'
import { nativeJevFixture, nativeJevInference } from './native.test-support'
import { makeJevTradingSignalRequest } from './trading-signals'
import { defaultJevProtocolDocument, jevBehaviorHash } from './protocol'
import type { ReplayJevCall } from '../intraday-replay/jev-timing'
import { jevInstructions } from './instructions'
import { applyJevInstructions } from './instruction-evaluation'
import {
  compareJevEconomics,
  jevBacktestOutcome,
  JevObservedNetEffect,
  type JevBacktestOutcome,
} from './experiment-economics'

const candidateInstructions = { ...jevInstructions, entry: 'Evaluate the supplied evidence for a new long entry.' }
const dates = Array.from({ length: 8 }, (_, i) =>
  Schema.decodeUnknownSync(IsoDateSchema)(`2026-09-${String(i + 1).padStart(2, '0')}`),
)
const registration = () => ({
  schemaVersion: 'bayn.jev-economic-registration.v2',
  studyId: 'a'.repeat(64),
  evaluatorSourceRevision: 'b'.repeat(40),
  compilerDependencyReceiptSha256: 'd'.repeat(64),
  registeredAt: '2026-08-31T00:00:00.000Z',
  baseline: jevInstructions,
  candidate: candidateInstructions,
  sessionDates: dates,
  maximumDrawdownMicros: '1000000',
})
const hash = (value: unknown) => Result.getOrThrow(canonicalHashV1Result(value))
const outcome = (run: string, net: readonly (string | null)[], candidate = false): JevBacktestOutcome => ({
  runId: run.repeat(64),
  reportHash: run.repeat(64),
  executableSha256: (candidate ? 'c' : 'a').repeat(64),
  variantBuildReceiptHash: candidate ? 'e'.repeat(64) : null,
  compilerDependencyReceiptSha256: candidate ? 'd'.repeat(64) : null,
  instructionsHash: hash(candidate ? candidateInstructions : jevInstructions),
  contextHash: 'd'.repeat(64),
  providerRequests: 8,
  executionPnlMicros: '0',
  knownModelCostMicros: '0',
  unresolvedModelCalls: 0,
  dataCostMicros: '0',
  remainingPositions: 0,
  issues: [],
  knownNetPnlMicros: '0',
  costCoverage: 'COMPLETE',
  conservativeMaximumDrawdownMicros: '0',
  rows: dates.map((sessionDate, i) => ({
    sessionDate,
    complete: net[i] != null,
    netMicros: net[i] ?? null,
    knownNativeNetMicros: net[i] ?? '0',
    infrastructure: { costMicros: '0', evidenceHash: 'f'.repeat(64) },
    research: { costMicros: '0', evidenceHash: 'f'.repeat(64) },
  })),
})
const flat = (value: string) => dates.map(() => value)
const compare = (next: readonly (string | null)[], baseline = flat('1000'), repeat = baseline) =>
  Result.getOrThrow(
    compareJevEconomics(registration(), {
      baseline: outcome('a', baseline),
      baselineRepeat: outcome('b', repeat),
      candidate: outcome('c', next, true),
    }),
  )

test('candidate dependency receipt must match the frozen image dependency registration', () => {
  expect(
    Result.isFailure(
      compareJevEconomics(
        { ...registration(), compilerDependencyReceiptSha256: '0'.repeat(64) },
        {
          baseline: outcome('a', flat('1000')),
          baselineRepeat: outcome('b', flat('1000')),
          candidate: outcome('c', flat('1500'), true),
        },
      ),
    ),
  ).toBe(true)
})

test('paired session net gain can be positive or negative without changing the opportunity count', () => {
  const positive = compare(flat('1500'))
  expect(positive.observedNetEffect).toBe(JevObservedNetEffect.Higher)
  expect(positive.pairedNetDeltaMicros).toBe('4000')
  expect(positive.economicImprovement).toBe('UNPROVEN')
  expect(positive.qualification).toBe('UNQUALIFIED')
  expect(positive.adoption).toBe('NOT_AUTHORIZED')
  expect(compare(flat('500')).observedNetEffect).toBe(JevObservedNetEffect.Lower)
  expect(compare(flat('1000')).observedNetEffect).toBe(JevObservedNetEffect.Unchanged)
})

test('a relative gain that still loses to cash remains unqualified', () => {
  const report = compare(flat('-100'), flat('-1000'))
  expect(report.pairedNetDeltaMicros).toBe('7200')
  expect(report.observedNetEffect).toBe(JevObservedNetEffect.Higher)
  expect(report.candidateNetMicros).toBe('-800')
  expect(report.economicImprovement).toBe('UNPROVEN')
})

test('missing costs and outcomes remain missing rather than being dropped or counted as zero', () => {
  const report = compare(['1500', null, ...flat('1500').slice(2)])
  expect(report.registeredSessionCount).toBe(8)
  expect(report.completePairedSessionCount).toBe(7)
  expect(report.pairedNetDeltaMicros).toBeNull()
  expect(report.observedNetEffect).toBe(JevObservedNetEffect.Inconclusive)
  expect(report.reasons).toContain('INCOMPLETE_NATIVE_OUTCOMES_OR_COSTS')
})

test('unchanged-prompt variability can explain an apparent candidate gain', () => {
  const report = compare(flat('1500'), flat('1000'), flat('2000'))
  expect(report.pairedNetDeltaMicros).toBe('4000')
  expect(report.unchangedPromptNetDeltaMicros).toBe('8000')
  expect(report.economicImprovement).toBe('UNPROVEN')
})

test('operating-cost receipt changes alter the terminal comparison identity even at the same price', () => {
  const arms = {
    baseline: outcome('a', flat('1000')),
    baselineRepeat: outcome('b', flat('1000')),
    candidate: outcome('c', flat('1500'), true),
  }
  const original = Result.getOrThrow(compareJevEconomics(registration(), arms))
  for (const arm of ['baseline', 'baselineRepeat', 'candidate'] as const) {
    const changed = Result.getOrThrow(
      compareJevEconomics(registration(), {
        ...arms,
        [arm]: {
          ...arms[arm],
          rows: arms[arm].rows.map((row) => ({
            ...row,
            infrastructure: { costMicros: '0', evidenceHash: 'e'.repeat(64) },
          })),
        },
      }),
    )
    expect(changed.pairedNetDeltaMicros).toBe(original.pairedNetDeltaMicros)
    expect(changed.comparisonHash).not.toBe(original.comparisonHash)
  }
})

test('an unchanged-prompt repeat using another executable cannot measure provider repeatability', () => {
  expect(
    Result.isFailure(
      compareJevEconomics(registration(), {
        baseline: outcome('a', flat('1000')),
        baselineRepeat: { ...outcome('b', flat('1000')), executableSha256: 'f'.repeat(64) },
        candidate: outcome('c', flat('1500'), true),
      }),
    ),
  ).toBe(true)
})

test('a candidate requires both changed instructions and a distinct compiled executable', () => {
  const arms = {
    baseline: outcome('a', flat('1000')),
    baselineRepeat: outcome('b', flat('1000')),
    candidate: outcome('c', flat('1500'), true),
  }
  expect(
    Result.isFailure(
      compareJevEconomics(
        { ...registration(), candidate: jevInstructions },
        { ...arms, candidate: { ...arms.candidate, instructionsHash: arms.baseline.instructionsHash } },
      ),
    ),
  ).toBe(true)
  expect(
    Result.isFailure(
      compareJevEconomics(registration(), {
        ...arms,
        candidate: { ...arms.candidate, executableSha256: arms.baseline.executableSha256 },
      }),
    ),
  ).toBe(true)
})

test('late declared registration and drawdown prevent a complete descriptive result', () => {
  const arms = {
    baseline: outcome('a', flat('1000')),
    baselineRepeat: outcome('b', flat('1000')),
    candidate: outcome('c', flat('1500'), true),
  }
  expect(
    Result.getOrThrow(compareJevEconomics({ ...registration(), registeredAt: '2026-09-01T00:00:00.000Z' }, arms))
      .observedNetEffect,
  ).toBe(JevObservedNetEffect.Inconclusive)
  const report = Result.getOrThrow(
    compareJevEconomics(registration(), {
      ...arms,
      candidate: { ...arms.candidate, conservativeMaximumDrawdownMicros: '1000001' },
    }),
  )
  expect(report.observedNetEffect).toBe(JevObservedNetEffect.Inconclusive)
})

test('changed source, capital, assumptions, date coverage or reused runs fail comparison', () => {
  const arms = {
    baseline: outcome('a', flat('1000')),
    baselineRepeat: outcome('b', flat('1000')),
    candidate: outcome('c', flat('1500'), true),
  }
  for (const candidate of [
    { ...arms.candidate, contextHash: 'e'.repeat(64) },
    { ...arms.candidate, rows: arms.candidate.rows.slice(1) },
    { ...arms.candidate, runId: arms.baseline.runId },
    { ...arms.candidate, instructionsHash: arms.baseline.instructionsHash },
  ])
    expect(Result.isFailure(compareJevEconomics(registration(), { ...arms, candidate }))).toBe(true)
})

test('the unchanged live baseline is required and paired session values are retained', () => {
  const arms = {
    baseline: outcome('a', flat('1000')),
    baselineRepeat: outcome('b', flat('1000')),
    candidate: outcome('c', flat('1500'), true),
  }
  expect(Result.isFailure(compareJevEconomics({ ...registration(), baseline: candidateInstructions }, arms))).toBe(true)
  const a = compare(['2000', '400', '1800', '900', '2100', '800', '1500', '1900'])
  expect(a.pairedSessions[0]).toEqual({
    sessionDate: dates[0],
    baselineNetMicros: '1000',
    baselineRepeatNetMicros: '1000',
    candidateNetMicros: '2000',
  })
})

const nativeReportFixture = (instructions = jevInstructions, run = 'a') => {
  const captured = retainedReplayFixture()
  const native = nativeJevFixture()
  const original = Result.getOrThrow(makeJevTradingSignalRequest(native.observation.payload, 'AAPL'))
  const prepared = Result.getOrThrow(applyJevInstructions(original.request, instructions))
  const at = '2026-09-04T14:30:02.000Z'
  const inference = nativeJevInference(prepared.request, at)
  const call: ReplayJevCall = {
    schemaVersion: 'bayn.replay-jev-call.v1',
    request: prepared.request,
    requestHash: prepared.requestHash,
    simulatedStartedAt: at,
    providerStartedAt: at,
    providerCompletedAt: at,
    outcome: { status: 'RECEIVED', inference },
  }
  let ledger = Result.getOrThrow(createReplayLedger<ReplayBrokerFill>('10000000000'))
  for (const [side, priceMicros] of [
    ['buy', '100000000'],
    ['sell', '110000000'],
  ] as const)
    ledger = Result.getOrThrow(
      applyReplayFill(
        ledger,
        {
          symbol: 'AAPL',
          executionIndex: side === 'buy' ? 0 : 1,
          brokerOrderId: `fixture-${side}`,
          clientOrderId: `fixture-${side}`,
          quoteSource: {
            topic: 'fixture',
            partition: 0,
            offset: side === 'buy' ? '0' : '1',
            availableAtMs: Date.parse(at),
          },
          side,
          observedAt: at,
          quantityAtoms: '1000000000',
          priceMicros,
          notionalMicros: priceMicros,
        },
        '1000000000',
        defaultJevProtocolDocument.executionModel,
        1000000,
      ),
    )
  const tariff = { inputMicrosPerMillionTokens: '42000', outputMicrosPerMillionTokens: '0' }
  const costs = calculateReplayJevCosts([call], tariff)
  if (ledger.netRealizedPnlAfterCostsMicros === null) throw Error('Fixture must close')
  const net = BigInt(ledger.netRealizedPnlAfterCostsMicros) - BigInt(costs.knownCostMicros) - 10n
  const material = {
    schemaVersion: 'bayn.backtest-report.v4',
    executableSha256: sha256('SYNTHETIC economic fixture executable ' + hash(instructions)),
    jevInstructions: { document: instructions, contentHash: hash(instructions) },
    evidenceMode: 'simulated-production-execution',
    runId: run.repeat(64),
    inference: {
      definition: {
        mode: 'measured-provider',
        maximumCalls: 1000,
        model: jevModel,
        inputDefinition: defaultJevProtocolDocument.inputDefinition,
        costs: tariff,
      },
      costs,
      calls: [call],
      providerDispatchCount: 1,
    },
    completion: 'COMPLETE',
    issues: [],
    source: {
      runId: run.repeat(64),
      sourceManifestHash: hash(captured.manifest),
      deliveryModel: captured.manifest.deliveryModel,
      marketSources: captured.manifest.marketSources,
    },
    sourceReceiptHash: captured.capture.contentHash,
    build: {
      sourceRevision: 'b'.repeat(40),
      imageRepository: 'registry.example/lab/bayn',
      declaredImageDigest: 'sha256:' + 'c'.repeat(64),
      imageDigestVerification: 'unverified-input',
      strategyBehaviorHash: jevBehaviorHash,
      strategyParameterHash: hash(defaultJevProtocolDocument),
      sourceAndStrategyVerification: 'configured',
    },
    assumptions: {
      instruments: replayTestInstruments,
      latencyMs: 100,
      slippageBps: 0,
      availableLiquidityPpm: 1000000,
      feeMultiplierPpm: 1000000,
    },
    sessionDates: ['2026-09-04'],
    maximumObservedDrawdownMicros: '100',
    reconciledExecutionPnlAfterCostsMicros: ledger.netRealizedPnlAfterCostsMicros,
    reconciledNetPnlAfterCostsMicros: String(net),
    dataCostMicros: '10',
    brokerState: { ledger },
    sessions: [
      {
        sessionDate: '2026-09-04',
        completion: 'COMPLETE',
        issues: [],
        closingNetEquityMicros: String(10000000000n + net),
        modelCosts: costs,
        allocatedDataCostMicros: '10',
        netEquityChangeMicros: String(net),
      },
    ],
  }
  const comparisonInput = Schema.decodeUnknownSync(BacktestComparisonInputSchema)({
    schemaVersion: 'bayn.backtest.v5',
    inference: material.inference.definition,
    allocatedDataCostPerSessionMicros: '10',
    interval: { startAt: '2026-09-04T13:30:00.000Z', endAt: '2026-09-04T20:00:00.000Z' },
    source: captured.manifest,
    openingCashMicros: ledger.openingCashMicros,
    fractionalTrading: false,
    calendar: captured.input.input.calendar,
    assets: captured.manifest.marketSources
      .flatMap((source) => source.symbols)
      .map((symbol, index) => ({
        id: `12345678-1234-4234-8234-${String(index).padStart(12, '0')}`,
        symbol,
        class: 'us_equity',
        exchange: 'NASDAQ',
        status: 'active',
        tradable: true,
        fractionable: true,
      })),
    assetObservationAt: '2026-09-04T13:29:00.000Z',
    assetObservationPolicy: 'retained-as-of-session',
    build: {
      sourceRevision: material.build.sourceRevision,
      imageRepository: material.build.imageRepository,
      imageDigest: material.build.declaredImageDigest,
      strategyBehaviorHash: material.build.strategyBehaviorHash,
      strategyParameterHash: material.build.strategyParameterHash,
    },
    assumptions: material.assumptions,
    cadence: {
      pollIntervalMs: 30000,
      reconciliationIntervalMs: 30000,
      reconciliationPassTimeoutMs: 30000,
      reconciliationStaleThresholdMs: 120000,
    },
  })
  const complete = { ...material, comparisonInput, comparisonInputHash: hash(comparisonInput) }
  return { ...complete, reportHash: hash(complete) }
}
const allocations = [
  {
    sessionDate: '2026-09-04',
    infrastructure: { costMicros: '2', evidenceHash: 'e'.repeat(64) },
    research: { costMicros: '3', evidenceHash: 'f'.repeat(64) },
  },
]
const project = (report: unknown, operatingAllocations: unknown = allocations) =>
  jevBacktestOutcome({ report, instructions: jevInstructions, operatingAllocations, variantBuild: null })
const compilerBuildFixture = (report: ReturnType<typeof nativeReportFixture>, instructions = candidateInstructions) => {
  const material = {
    schemaVersion: 'bayn.jev-instruction-variant-build.v1',
    spec: {
      schemaVersion: 'bayn.jev-instruction-variant.v1',
      evaluation: 'portfolio',
      sourceRevision: report.build.sourceRevision,
      imageRepository: report.build.imageRepository,
      baseImageDigest: report.build.declaredImageDigest,
      instructions,
      dependencyReceiptSha256: 'd'.repeat(64),
    },
    baselineInstructionsHash: hash(jevInstructions),
    instructionsHash: hash(instructions),
    strategyBehaviorHash: report.build.strategyBehaviorHash,
    strategyParameterHash: report.build.strategyParameterHash,
    executableSha256: report.executableSha256,
    bunVersion: '1.4.2',
    replacedSourceModule: 'services/bayn/src/jev/instructions.ts',
    sourceVerification: 'CLEAN_COMMITTED_BUILD_INPUTS',
    dependencyVerification: 'PINNED_IMAGE_INPUT_BYTES',
    baseImageVerification: 'REQUIRES_RUNTIME_READBACK',
    qualification: 'UNQUALIFIED',
  }
  return { ...material, receiptHash: hash(material) }
}
const reseal = <R extends { readonly reportHash: string }>(report: R) => {
  const { reportHash: _, ...material } = report
  return { ...material, reportHash: hash(material) }
}

test('candidate compiler receipts bind clean source, instruction bytes and the actual executable', () => {
  const report = nativeReportFixture(candidateInstructions)
  const build = compilerBuildFixture(report)
  const check = (variantBuild: unknown) =>
    jevBacktestOutcome({
      report,
      instructions: candidateInstructions,
      operatingAllocations: allocations,
      variantBuild,
    })
  const resealBuild = (value: typeof build) => {
    const { receiptHash: _old, ...material } = value
    return { ...material, receiptHash: hash(material) }
  }
  for (const invalid of [
    null,
    { ...build, receiptHash: '0'.repeat(64) },
    resealBuild({ ...build, executableSha256: '0'.repeat(64) }),
    resealBuild({ ...build, sourceVerification: 'DIRTY' }),
    resealBuild({ ...build, baselineInstructionsHash: '0'.repeat(64) }),
    resealBuild({ ...build, strategyBehaviorHash: '0'.repeat(64) }),
    resealBuild({ ...build, strategyParameterHash: '0'.repeat(64) }),
    resealBuild({ ...build, instructionsHash: '0'.repeat(64) }),
    resealBuild({ ...build, bunVersion: '1.4.1' }),
    resealBuild({ ...build, spec: { ...build.spec, sourceRevision: '0'.repeat(40) } }),
    resealBuild({ ...build, spec: { ...build.spec, imageRepository: 'example.com/other' } }),
    resealBuild({ ...build, spec: { ...build.spec, baseImageDigest: 'sha256:' + '0'.repeat(64) } }),
    resealBuild({ ...build, spec: { ...build.spec, instructions: jevInstructions } }),
  ])
    expect(Result.isFailure(check(invalid))).toBe(true)
  expect(Result.getOrThrow(check(build)).variantBuildReceiptHash).toBe(build.receiptHash)
})

test('native fills and metered calls reproduce net returns with fees booked once and operating costs added', () => {
  const report = nativeReportFixture()
  const result = Result.getOrThrow(project(report))
  expect(result.rows[0]?.netMicros).toBe(String(BigInt(report.reconciledNetPnlAfterCostsMicros) - 5n))
  expect(result.conservativeMaximumDrawdownMicros).toBe('105')
  expect(BigInt(report.brokerState.ledger.executionFeesMicros)).toBeGreaterThan(0n)
  expect(result.providerRequests).toBe(1)
  const next = reseal({ ...report, runId: 'b'.repeat(64), source: { ...report.source, runId: 'b'.repeat(64) } })
  expect(Result.getOrThrow(project(next)).contextHash).toBe(result.contextHash)
})

test('retained received calls cannot exceed the provider budget by understating dispatch count', () => {
  const original = nativeReportFixture()
  const calls = [...original.inference.calls, ...original.inference.calls]
  const costs = calculateReplayJevCosts(calls, original.inference.definition.costs)
  const difference = BigInt(costs.knownCostMicros) - BigInt(original.inference.costs.knownCostMicros)
  const definition = { ...original.inference.definition, maximumCalls: 1 }
  const comparisonInput = { ...original.comparisonInput, inference: definition }
  const report = reseal({
    ...original,
    comparisonInput,
    comparisonInputHash: hash(comparisonInput),
    inference: { definition, calls, costs, providerDispatchCount: 1 },
    reconciledNetPnlAfterCostsMicros: String(BigInt(original.reconciledNetPnlAfterCostsMicros) - difference),
    sessions: original.sessions.map((row) => ({
      ...row,
      modelCosts: costs,
      closingNetEquityMicros: String(BigInt(row.closingNetEquityMicros) - difference),
      netEquityChangeMicros: String(BigInt(row.netEquityChangeMicros) - difference),
    })),
  })
  expect(Result.isFailure(project(report))).toBe(true)
  expect(
    Result.isFailure(
      project(
        reseal({
          ...original,
          inference: { ...original.inference, providerDispatchCount: 0 },
        }),
      ),
    ),
  ).toBe(true)
})

test('undispatched and ambiguous calls retain their budget bounds and incomplete costs', () => {
  const original = nativeReportFixture()
  const call = original.inference.calls[0]
  if (call === undefined) throw Error('Fixture needs a retained provider call')
  const outcomes: ReplayJevCall['outcome'][] = [
    {
      status: 'FAILED',
      failure: JevFailure.NotDispatched,
      httpStatus: null,
      responseHash: null,
      rejectedResponse: null,
    },
    { status: 'INTERRUPTED' },
    { status: 'DEFECT' },
  ]
  for (const outcome of outcomes) {
    const calls = [{ ...call, outcome }]
    const costs = calculateReplayJevCosts(calls, original.inference.definition.costs)
    const material = {
      ...original,
      completion: 'INCOMPLETE',
      issues: [BacktestIssue.UnresolvedModelCost],
      maximumObservedDrawdownMicros: null,
      reconciledNetPnlAfterCostsMicros: null,
      inference: { ...original.inference, calls, costs, providerDispatchCount: 0 },
      sessions: original.sessions.map((row) => ({
        ...row,
        completion: 'INCOMPLETE',
        issues: [BacktestIssue.UnresolvedModelCost],
        modelCosts: costs,
        closingNetEquityMicros: String(BigInt(row.closingNetEquityMicros) + BigInt(row.modelCosts.knownCostMicros)),
        netEquityChangeMicros: null,
      })),
    }
    expect(Result.getOrThrow(project(reseal(material))).rows.every((row) => !row.complete)).toBe(true)
    const maximumDispatches = outcome.status === 'FAILED' ? 0 : 1
    expect(
      Result.isSuccess(
        project(
          reseal({
            ...material,
            inference: { ...material.inference, providerDispatchCount: maximumDispatches },
          }),
        ),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        project(
          reseal({
            ...material,
            inference: { ...material.inference, providerDispatchCount: maximumDispatches + 1 },
          }),
        ),
      ),
    ).toBe(true)
  }
})

test('changed native report bytes, cash, costs and response identities fail instead of scoring', () => {
  const report = nativeReportFixture()
  const changed = [
    { ...report, reportHash: '0'.repeat(64) },
    reseal({ ...report, comparisonInputHash: '0'.repeat(64) }),
    reseal({ ...report, build: { ...report.build, strategyParameterHash: '0'.repeat(64) } }),
    reseal({ ...report, brokerState: { ledger: { ...report.brokerState.ledger, cashMicros: '10000000000' } } }),
    reseal({
      ...report,
      inference: { ...report.inference, costs: { ...report.inference.costs, knownCostMicros: '0' } },
    }),
    reseal({ ...report, sessions: report.sessions.map((row) => ({ ...row, netEquityChangeMicros: '1' })) }),
    reseal({
      ...report,
      sessions: report.sessions.map((row) => ({ ...row, modelCosts: { ...row.modelCosts, callCount: 0 } })),
    }),
  ]
  for (const value of changed) expect(Result.isFailure(project(value))).toBe(true)
  expect(
    Result.isFailure(
      jevBacktestOutcome({
        report,
        instructions: candidateInstructions,
        operatingAllocations: allocations,
        variantBuild: null,
      }),
    ),
  ).toBe(true)
})

test('a native engine report without an identified executable cannot enter the economic comparison', () => {
  const report = nativeReportFixture()
  const { executableSha256: _executable, ...raw } = report
  expect(Result.isFailure(project(reseal(raw)))).toBe(true)
})

test('unknown native data allocations remain unknown and cannot produce a complete net result', () => {
  const original = nativeReportFixture()
  const comparisonInput = { ...original.comparisonInput, allocatedDataCostPerSessionMicros: null }
  const report = reseal({
    ...original,
    comparisonInput,
    comparisonInputHash: hash(comparisonInput),
    completion: 'INCOMPLETE',
    issues: ['unresolved-data-cost'],
    dataCostMicros: null,
    reconciledNetPnlAfterCostsMicros: null,
    maximumObservedDrawdownMicros: null,
    sessions: original.sessions.map((session) => ({
      ...session,
      completion: 'INCOMPLETE',
      issues: ['unresolved-data-cost'],
      allocatedDataCostMicros: null,
      netEquityChangeMicros: null,
      closingNetEquityMicros: String(BigInt(session.closingNetEquityMicros) + 10n),
    })),
  })
  const result = Result.getOrThrow(project(report))
  expect(result.rows[0]?.complete).toBe(false)
  expect(result.rows[0]?.netMicros).toBeNull()
  expect(result.conservativeMaximumDrawdownMicros).toBeNull()
  expect(Result.isFailure(project(reseal({ ...report, dataCostMicros: '0' })))).toBe(true)
  expect(Result.isFailure(project(reseal({ ...report, completion: 'COMPLETE' })))).toBe(true)
})

test.each([
  BacktestIssue.CycleFailure,
  BacktestIssue.InexactAccounting,
  BacktestIssue.UnresolvedMutation,
  BacktestIssue.UnclosedOrder,
  BacktestIssue.MissingValuation,
])('native fitness retains a session-only %s failure even when its ending ledger is flat', (issue) => {
  const original = nativeReportFixture()
  const report = reseal({
    ...original,
    completion: 'INCOMPLETE',
    reconciledNetPnlAfterCostsMicros: null,
    maximumObservedDrawdownMicros: null,
    sessions: original.sessions.map((session) => ({
      ...session,
      completion: 'INCOMPLETE',
      issues: [issue],
      netEquityChangeMicros: null,
    })),
  })
  const outcome = Result.getOrThrow(project(report))
  expect(outcome.remainingPositions).toBe(0)
  expect(outcome.knownNetPnlMicros).not.toBeNull()
  expect(outcome.issues).toContain(issue)
})

test('fractional trading, broker assets, calendar and cadence changes cannot masquerade as instruction effects', () => {
  const baselineReport = nativeReportFixture()
  const repeated = nativeReportFixture(jevInstructions, 'b')
  const candidate = nativeReportFixture(candidateInstructions, 'c')
  const arms = {
    baseline: Result.getOrThrow(project(baselineReport)),
    baselineRepeat: Result.getOrThrow(project(repeated)),
  }
  const input = candidate.comparisonInput
  const variants = [
    { ...input, fractionalTrading: !input.fractionalTrading },
    { ...input, assets: input.assets.map((asset) => ({ ...asset, fractionable: false })) },
    { ...input, calendar: input.calendar.map((day) => ({ ...day, open: '09:31', session_open: '0931' })) },
    { ...input, cadence: { ...input.cadence, pollIntervalMs: input.cadence.pollIntervalMs + 1 } },
  ]
  for (const comparisonInput of variants) {
    const report = reseal({ ...candidate, comparisonInput, comparisonInputHash: hash(comparisonInput) })
    const changed = Result.getOrThrow(
      jevBacktestOutcome({
        report,
        instructions: candidateInstructions,
        operatingAllocations: allocations,
        variantBuild: compilerBuildFixture(report),
      }),
    )
    expect(changed.contextHash).not.toBe(arms.baseline.contextHash)
    expect(
      Result.isFailure(
        compareJevEconomics({ ...registration(), sessionDates: ['2026-09-04'] }, { ...arms, candidate: changed }),
      ),
    ).toBe(true)
  }
})

test('unallocated native operating expenses and missing session rows cannot complete the result', () => {
  const report = nativeReportFixture()
  const unknown = Result.getOrThrow(
    project(
      report,
      allocations.map((row) => ({ ...row, research: null })),
    ),
  )
  expect(unknown.rows[0]?.netMicros).toBeNull()
  expect(unknown.conservativeMaximumDrawdownMicros).toBeNull()
  expect(Result.isFailure(project(report, []))).toBe(true)
})

test.each([
  {
    name: 'known infrastructure and unknown research',
    infrastructure: '1000000000',
    research: null,
    known: 1000000000n,
  },
  {
    name: 'unknown infrastructure and known research',
    infrastructure: null,
    research: '1000000000',
    known: 1000000000n,
  },
  { name: 'both known expenses exactly once', infrastructure: '2', research: '3', known: 5n },
  { name: 'both unknown expenses', infrastructure: null, research: null, known: 0n },
  { name: 'explicit zero and unknown expense', infrastructure: '0', research: null, known: 0n },
])('known-cost fitness retains $name without completing unknown costs', ({ infrastructure, research, known }) => {
  const report = nativeReportFixture()
  const operatingAllocations = allocations.map((row) => ({
    ...row,
    infrastructure: infrastructure === null ? null : { ...row.infrastructure, costMicros: infrastructure },
    research: research === null ? null : { ...row.research, costMicros: research },
  }))
  const outcome = Result.getOrThrow(project(report, operatingAllocations))
  const complete = infrastructure !== null && research !== null
  const expectedKnownNet = String(BigInt(report.reconciledNetPnlAfterCostsMicros) - known)
  expect(outcome.knownNetPnlMicros).toBe(expectedKnownNet)
  expect(outcome.costCoverage).toBe(complete ? 'COMPLETE' : 'KNOWN_COSTS_ONLY')
  expect(outcome.rows[0]?.complete).toBe(complete)
  expect(outcome.rows[0]?.netMicros).toBe(complete ? expectedKnownNet : null)
  expect(outcome.conservativeMaximumDrawdownMicros).toBe(complete ? String(100n + known) : null)
  expect(outcome.rows[0]?.infrastructure).toEqual(operatingAllocations[0]?.infrastructure)
  expect(outcome.rows[0]?.research).toEqual(operatingAllocations[0]?.research)
  if (known === 1000000000n) expect(BigInt(outcome.knownNetPnlMicros ?? '0')).toBeLessThan(0n)
})

test('comparison command reads complete digest-bound native files above 256 MiB without provider credentials', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'bayn-experiment-economics-' })
      const artifact = (name: string, report: unknown) =>
        Effect.gen(function* () {
          const raw = JSON.stringify(report) + (name === 'baseline' ? ' '.repeat(257 * 1024 * 1024) : '')
          const path = `${directory}/${name}.json`
          yield* fs.writeFileString(path, raw)
          return { reportPath: path, reportSha256: sha256(raw), operatingAllocations: allocations }
        })
      const baseline = yield* artifact('baseline', nativeReportFixture())
      const baselineRepeat = yield* artifact('repeat', nativeReportFixture(jevInstructions, 'b'))
      const candidateReport = nativeReportFixture(candidateInstructions, 'c')
      const buildPath = `${directory}/candidate-build.json`
      const buildRaw = JSON.stringify(compilerBuildFixture(candidateReport))
      yield* fs.writeFileString(buildPath, buildRaw)
      const candidate = {
        ...(yield* artifact('candidate', candidateReport)),
        buildReceipt: { path: buildPath, sha256: sha256(buildRaw) },
      }
      const manifest = {
        schemaVersion: 'bayn.jev-economic-manifest.v2',
        registration: { ...registration(), sessionDates: ['2026-09-04'] },
        baseline,
        baselineRepeat,
        candidate,
      }
      const path = `${directory}/manifest.json`
      const output = `${directory}/comparison.json`
      yield* fs.writeFileString(path, JSON.stringify(manifest))
      yield* jevEvaluationCommand(['--compare', path, '--output', output])
      const result = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            observedNetEffect: Schema.Enum(JevObservedNetEffect),
            economicImprovement: Schema.Literal('UNPROVEN'),
            candidateBuildReceiptHash: Schema.String,
          }),
        ),
      )(yield* fs.readFileString(output))
      expect(result.observedNetEffect).toBe(JevObservedNetEffect.Unchanged)
      expect(result.candidateBuildReceiptHash).toBe(compilerBuildFixture(candidateReport).receiptHash)
      const before = yield* fs.readFileString(output)
      expect((yield* jevEvaluationCommand(['--compare', path, '--output', output]).pipe(Effect.result))._tag).toBe(
        'Failure',
      )
      expect(yield* fs.readFileString(output)).toBe(before)
      yield* fs.writeFileString(buildPath, '{}')
      const rejectedBuildOutput = `${directory}/tampered-build.json`
      expect(
        (yield* jevEvaluationCommand(['--compare', path, '--output', rejectedBuildOutput]).pipe(Effect.result))._tag,
      ).toBe('Failure')
      expect(yield* fs.exists(rejectedBuildOutput)).toBe(false)
      yield* fs.writeFileString(buildPath, buildRaw)
      yield* fs.writeFileString(baseline.reportPath, '{}')
      expect(
        (yield* jevEvaluationCommand(['--compare', path, '--output', `${directory}/tampered.json`]).pipe(Effect.result))
          ._tag,
      ).toBe('Failure')
      expect(yield* fs.exists(`${directory}/tampered.json`)).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
}, 15_000)
