import { Result } from 'effect'
import {
  backtestBrokerEvidenceConfig,
  backtestComparisonInput,
  type prepareBacktest,
  type BacktestInputSchema,
} from '../intraday-replay/backtest'
import { makeReplayBrokerCheckpoint } from '../intraday-replay/broker-checkpoint'
import { createReplayLedger } from '../intraday-replay/ledger'
import { calculateReplayInferenceCosts } from '../intraday-replay/inference-costs'
import { OperatingCostCategory, OperatingCostCoverage } from '../operating-costs'
import { ReconciliationStatus } from '../execution/contracts'
import { sha256 } from '../hash'
import { testHash } from './fixtures.test-support'
import type { nativeLatencyBacktestFixture } from './latency.test-support'
import type { ReplayImagePlatform } from './replay-image-platform'
import type { SystemRegistration } from './policy'
import type { SystemSourceCut } from './source-cut'

type LatencyArtifactInput = Omit<
  ReturnType<typeof nativeLatencyBacktestFixture>,
  'input' | 'prepared' | 'registration' | 'cut'
> & {
  readonly input: typeof BacktestInputSchema.Type
  readonly prepared: Result.Result.Success<ReturnType<typeof prepareBacktest>>
  readonly registration: SystemRegistration
  readonly cut: SystemSourceCut
}

export const completeLatencyArtifactFixture = (
  fixture: LatencyArtifactInput,
  executableSha256 = testHash('test executable'),
  imagePlatform: ReplayImagePlatform | null = null,
) => {
  const { input, prepared, registration, cut, capture, source, first, last } = fixture
  const stress = prepared.latencyStress
  const definition = registration.policies.find((p) => p.policy === input.policy)
  if (stress === null || definition === undefined) throw new Error('Missing stress preparation')
  const brokerConfig = Result.getOrThrow(backtestBrokerEvidenceConfig(prepared))
  const checkpoint = Result.getOrThrow(
    makeReplayBrokerCheckpoint(
      brokerConfig,
      {
        schemaVersion: 'bayn.simulated-broker-state.v7',
        runId: prepared.runId,
        accountId: `replay-${prepared.runId}`,
        createdAt: first.openAt,
        ledger: Result.getOrThrow(createReplayLedger(input.openingCashMicros)),
        orders: [],
        fills: [],
        fees: [],
        sessionCloses: registration.calendar.sessions.map((s) => ({
          sessionDate: s.sessionDate,
          equityMicros: input.openingCashMicros,
          valuationQualified: true,
        })),
      },
      last.closeAt,
    ),
  )
  const report = {
    schemaVersion:
      input.schemaVersion === 'bayn.backtest.v11'
        ? 'bayn.backtest-report.v9'
        : input.schemaVersion === 'bayn.backtest.v13'
          ? 'bayn.backtest-report.v11'
          : 'bayn.backtest-report.v10',
    ...(input.schemaVersion === 'bayn.backtest.v11'
      ? {}
      : { alphaObservations: [], alphaBaselineGaps: [], decisions: [] }),
    runId: prepared.runId,
    executableSha256,
    evidenceMode: 'simulated-production-execution',
    completion: 'COMPLETE',
    issues: [],
    sessionDates: registration.calendar.sessions.map((s) => s.sessionDate),
    sessions: registration.calendar.sessions.map((s) => ({
      sessionDate: s.sessionDate,
      completion: 'COMPLETE',
      issues: [],
      schedule: {
        firstPollAtMs: Date.parse(s.openAt),
        lastPollAtMs: Date.parse(s.closeAt),
        completedAtMs: Date.parse(s.closeAt),
        passCount: 1,
        failedPassCount: 0,
        unavailableDecisionPassCount: 0,
      },
      valuationFailureCount: 0,
      closingEquity: {
        equityMicros: input.openingCashMicros,
        valuationQualified: true,
        openOrderCount: 0,
      },
      reconciliation: {
        report: {
          reconciliation: { status: ReconciliationStatus.Exact },
          metrics: {
            accountingExact: true,
            discrepancyCount: 0,
            cashDifferenceMicros: '0',
            positionDifferenceMicros: '0',
            equityDifferenceMicros: '0',
            brokerPollAgeMs: 0,
            oldestUnknownMutationAgeMs: 0,
          },
        },
        brokerState: { unknownOrderCount: 0 },
        riskContext: { unknownMutationCount: 0 },
      },
      remainingPositions: [],
      modelCosts: calculateReplayInferenceCosts([], input.inference.costs),
      allocatedDataCostMicros: input.allocatedDataCostPerSessionMicros,
    })),
    comparisonInput: backtestComparisonInput(input),
    comparisonInputHash: testHash(backtestComparisonInput(input)),
    sourceReceiptHash: capture.contentHash,
    build: {
      ...prepared.buildEvidence,
      sourceAndStrategyVerification: imagePlatform === null ? 'configured' : 'embedded',
    },
    brokerState: checkpoint.state,
    brokerCheckpoint: checkpoint,
    inference: { definition: input.inference, calls: [], providerDispatchCount: 0, retainedCallCount: 0 },
    batches: [],
    momentumObservations: [],
    latencyStress: {
      protocol: stress.protocol,
      protocolHash: stress.protocolHash,
      calibration: stress.calibration,
      admittedObservationCount: 0,
      unreleasedObservationHashes: [],
      observationReceipts: [],
      admittedBatchCount: 0,
      unreleasedBatchIds: [],
      receipts: [],
    },
  }
  const costSource = testHash('explicit complete zero-cost coverage')
  const costs = {
    policy: input.policy,
    allocationRuleHash: definition.costAllocationRuleHash,
    asOf: cut.asOf,
    inferenceCalls: [],
    inferenceTariff: input.inference.costs,
    sessions: registration.calendar.sessions.map((s) => ({
      schemaVersion: 'bayn.operating-cost-evidence.v1',
      accountBindingHash: definition.accountBindingHash,
      sessionDate: s.sessionDate,
      asOf: cut.asOf,
      currency: 'USD',
      trading: null,
      coverage: Object.values(OperatingCostCategory).map((category) => ({
        category,
        status: OperatingCostCoverage.Complete,
        sourceHash: costSource,
      })),
      consumption: [],
      prepaidFunding: [],
    })),
  }
  const artifacts = new Map<string, Uint8Array>()
  const retain = (value: unknown) => {
    const text = JSON.stringify(value)
    const hash = sha256(text)
    artifacts.set(hash, new TextEncoder().encode(text))
    return hash
  }
  const descriptor = {
    policy: input.policy,
    imagePlatform,
    executionReceiptHash: null,
    inputFileHash: retain(input),
    captureFileHash: retain(capture.value),
    reportFileHash: retain({ ...report, reportHash: testHash(report) }),
    costsFileHash: retain(costs),
  }
  const sources = new Set([
    ...artifacts.keys(),
    ...registration.costAllocationPlans.map((plan) => plan.basisSourceHash),
    costSource,
    definition.costAllocationRuleHash,
    report.executableSha256,
    source.dataSha256,
  ])
  return { checkpoint, report, costs, artifacts, retain, descriptor, sources }
}
