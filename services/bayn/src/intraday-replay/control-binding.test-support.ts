import { Result } from 'effect'

import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import { Authority, KillState } from '../execution/contracts'
import { legacyAuthorityStateSchemaVersion } from '../execution/legacy-wire'
import { makeExecutionRiskPolicy } from '../execution/risk-policy'
import { canonicalHashV1Result, sha256 } from '../hash'
import { nativeJevFixture } from '../jev/native.test-support'
import { JevPurpose } from '../jev/portfolio'
import { defaultJevProtocolDocument } from '../jev/protocol'
import { nativeArrivalCaptureId } from '../market-data/streaming/native-arrival'
import { nativeArrivalEpochFixture } from '../market-data/streaming/native-arrival.test-support'
import { reconciledStateHash } from '../simulation-reconciliation/broker-model'
import { frozenControlFixture } from './control-study.test-support'
import { validateBacktestSourceReceipt } from './source'

const hash = (value: unknown) => Result.getOrThrow(canonicalHashV1Result(value))

export const controlBindingFixture = () => {
  const base = frozenControlFixture()
  const native = nativeJevFixture()
  const { source: _source, openingCashMicros: cash, ...backtest } = base.input.backtest
  const { openingPeakEquityMicros: _peak, backtest: _backtest, ...template } = base.input
  const observedAt = new Date(Date.parse(backtest.interval.startAt) - 1000).toISOString()
  const state = {
    ...native.portfolio.brokerState,
    account: {
      ...native.portfolio.brokerState.account,
      cashMicros: cash,
      equityMicros: cash,
      buyingPowerMicros: cash,
      observedAt,
    },
    positions: [],
    positionsObservedAt: observedAt,
    orders: [],
    ordersObservedAt: observedAt,
    reconciliation: { ...native.portfolio.brokerState.reconciliation, reconciledAt: observedAt },
  }
  const stateHash = Result.getOrThrow(reconciledStateHash(state))
  state.reconciliation = { ...state.reconciliation, expectedHash: stateHash, observedHash: stateHash }
  const broker = Result.getOrThrow(
    makeBrokerIdentity({
      schemaVersion: 'bayn.broker-identity.v2',
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      accountId: state.account.accountId,
    }),
  )
  const policy = Result.getOrThrow(
    makeExecutionRiskPolicy(broker.accountId, defaultJevProtocolDocument.universe, broker.environment),
  )
  const plan = {
    schemaVersion: 'bayn.control-study-plan.v1',
    candidate: {
      broker,
      requestHash: sha256('native request'),
      authorityGenerationHash: native.input.authorityGenerationHash,
      riskPolicy: policy,
    },
    controlTemplate: {
      ...template,
      riskEnvironment: broker.environment,
      costObjective: 'KNOWN_COST_DIAGNOSTIC',
      backtest: { ...backtest, allocatedDataCostPerSessionMicros: null },
    },
  }
  const opening = {
    schemaVersion: 'bayn.control-study-opening.v1',
    broker,
    requestHash: plan.candidate.requestHash,
    build: backtest.build,
    dailyTradedNotionalMicros: '0',
    inputs: {
      schemaVersion: 'bayn.account-protection-inputs.v1',
      observedAt,
      portfolio: { purpose: JevPurpose.Entry, brokerState: state },
      policy,
      authority: {
        schemaVersion: legacyAuthorityStateSchemaVersion,
        generationHash: plan.candidate.authorityGenerationHash,
        maximum: Authority.Execution,
        effective: Authority.Execution,
        kill: KillState.Clear,
        version: 1,
        updatedAt: observedAt,
      },
      authorityObservedAt: observedAt,
      reconciliation: state.reconciliation,
      accountingExact: true,
      tradingDate: '2026-09-04',
      unknownMutationCount: 0,
      dayStartEquityMicros: cash,
      peakEquityMicros: (BigInt(cash) + 1_000_000_000n).toString(),
    },
  }
  const epoch = {
    ...nativeArrivalEpochFixture,
    build: { ...backtest.build, verification: 'embedded' as const },
    sources: base.source.marketSources,
  }
  epoch.captureId = Result.getOrThrow(nativeArrivalCaptureId(epoch.build, epoch.bootstrap, epoch.sources))
  const exported = {
    schemaVersion: 'bayn.native-arrival-export.v1',
    epoch,
    throughOrdinal: 1,
    finalChunkHash: sha256('synthetic final chunk'),
    dataSha256: base.source.dataSha256,
  }
  const source = {
    ...base.source,
    coverageStartMs: Date.parse(backtest.interval.startAt) - 60_000,
    transport: 'original-capture',
    deliveryModel: {
      schemaVersion: 'bayn.original-capture-arrivals.v1',
      description: 'Synthetic binding fixture; no economic study or broker outcome',
      tieBreak: 'availability-receipt-sequence',
      captureId: epoch.captureId,
      consumerEpoch: epoch.bootstrap.epoch,
      exportManifestHash: hash(exported),
      intervalReceiptHash: sha256('synthetic interval'),
      finalConsumerSequence: base.source.recordCount,
    },
    nativeVisiblePartitions: base.source.positions.map(({ topic, partition }) => ({ topic, partition })),
  }
  const receiptText = JSON.stringify({
    schemaVersion: 'bayn.original-capture-replay-receipt.v2',
    recordedAt: '2026-09-08T20:01:00.000Z',
    origin: source.origin,
    coverageStartMs: source.coverageStartMs,
    coverageEndMs: source.coverageEndMs,
    marketSources: source.marketSources,
    positions: source.positions,
    nativeVisiblePartitions: source.nativeVisiblePartitions,
    deliveryModel: source.deliveryModel,
    sourceDataSha256: source.dataSha256,
  })
  const receipt = Result.getOrThrow(validateBacktestSourceReceipt(receiptText, sha256(receiptText)))
  return { plan, opening, exported, source, receipt, receiptText }
}
