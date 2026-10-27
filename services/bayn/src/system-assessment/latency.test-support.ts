import { Effect, Result, Schema } from 'effect'

import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import { MutationEventSchema, MutationEventType } from '../execution/mutations/model'
import { matchedCommittedDecisionFixture } from '../intraday-replay/matched-entry.test-support'
import { decideJevEntry } from '../jev/decision'
import { nativeJevDecisionEvidence, nativeJevFixture } from '../jev/native.test-support'
import { IntradaySnapshotPurpose } from '../market-data/intraday/model'
import { exchangeSessions } from '../market-hours'
import { IsoDateSchema } from '../schemas'
import type { ExecutionDecisionDocument } from '../shadow-decision-contract'
import { streamingFixtureFromRaw } from '../testing/streaming-market-fixture'
import { ControllerPassEvidenceSchema } from './decision-work'
import {
  registrationFixture,
  replayRateCardFixture,
  testHash,
  withRegistrationCommitments,
  registeredRiskFixture,
} from './fixtures.test-support'
import { measureFullBatchLatency } from './full-batch-latency'
import { ObligationClass } from './reliability'
import { registeredSchedule } from './schedule'
import { SystemSourceCutSchema, type SystemSourceCut } from './source-cut'
import { latencyReplayExecutionModelHash, latencyReplayPolicyMaterial } from './latency-replay'
import { BacktestInputSchema, prepareBacktest } from '../intraday-replay/backtest'
import { retainedReplayFixture, retainedReplayCaptureFixture } from '../testing/retained-replay-fixture'
import { config } from '../testing/runtime-fixtures'
import { replayTestInstruments } from '../testing/replay-instruments'
import { instrumentMarket, MarketKind } from '../instruments'
import { backtestSourcePartitions } from '../intraday-replay/source'
import { MarketSourcesSchema } from '../market-data/streaming/raw-events'
import { jevInstructions } from '../jev/instructions'
import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import { JevResearchPolicy } from '../jev/acceptance'
import { nativeReplayPolicyIdentity, type NativeReplayPolicy } from '../intraday-replay/native-policy'
import type { BacktestSourceManifest } from '../intraday-replay/source'

export const calibrateNativeLatencyFixture = (native: ReturnType<typeof nativeJevFixture>) =>
  Effect.suspend(() => {
    const evidence = nativeJevDecisionEvidence(native)
    const target = Result.getOrThrow(decideJevEntry(evidence))
    const {
      candidateEvidencePolicy: _a,
      benchmarkEvidencePolicy: _b,
      candidateSymbols: _c,
      benchmarkSymbols: _d,
      ...query
    } = native.query
    const pricing = streamingFixtureFromRaw(native.snapshot, {
      ...query,
      observedAt: target.decidedAt,
      symbols: target.selectedSymbols,
      purpose: IntradaySnapshotPurpose.EntryPricing,
    }).snapshot
    return matchedCommittedDecisionFixture(native, evidence, '100000000000', pricing, 3).pipe(
      Effect.map((document) => ({ native, document })),
    )
  })

export const latencyCalibrationDecisionFixture = Effect.suspend(() => calibrateNativeLatencyFixture(nativeJevFixture()))

export const fullBatchLatencyFixture = (
  document: ExecutionDecisionDocument,
  native: ReturnType<typeof nativeJevFixture>,
  sessions?: ReturnType<typeof registrationFixture>['calendar']['sessions'],
) => {
  const target = document.strategyDecision
  if (target?.schemaVersion !== 'bayn.jev-entry-target.v7' || !document.dispatchable)
    throw new Error('Expected dispatchable native entry')
  const { observation, batchPlan, batchResult } = target.evidence
  const identity = Result.getOrThrow(
    makeBrokerIdentity({
      schemaVersion: 'bayn.broker-identity.v2',
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      accountId: document.bindings.accountId,
    }),
  )
  const accountBindingHash = testHash({
    schemaVersion: 'bayn.inference-cost-account.v1',
    accountId: identity.accountId,
  })
  const session = exchangeSessions(native.snapshot.manifest.calendar).find(
    (s) => s.date === native.snapshot.manifest.sessionDate,
  )
  if (session === undefined) throw new Error('Missing native session')
  const base = registrationFixture()
  const registration = withRegistrationCommitments({
    ...base,
    registeredAt: '2026-01-01T00:00:00.000Z',
    calendar: {
      ...base.calendar,
      sessions: sessions ?? [
        {
          sessionDate: Schema.decodeUnknownSync(IsoDateSchema)(session.date),
          openAt: session.openAt,
          closeAt: session.closeAt,
        },
        ...base.calendar.sessions.slice(1),
      ],
    },
    policies: base.policies.map((p) =>
      p.policy === 'JEV'
        ? {
            ...p,
            ...registeredRiskFixture(identity.accountId),
            authorityGenerationHash: document.bindings.authorityGenerationHash,
            protocolHash: document.bindings.strategyProtocolHash,
          }
        : p,
    ),
  })
  const at = (ms: number) => new Date(Date.parse(document.createdAt) + ms).toISOString()
  const batchPass = Schema.decodeUnknownSync(ControllerPassEvidenceSchema)({
    controllerKey: identity.identityHash,
    planHash: registration.obligations.configuration.controllerPlanHash,
    epoch: 1,
    sequence: 0,
    receiptHash: testHash('batch-pass'),
    completedAt: at(20),
    observation: {
      result: 'SUCCESS',
      outcome: 'ACQUIRED',
      observedAt: at(20),
      executionIssuedAt: new Date(Date.parse(observation.observedAt) - 10).toISOString(),
      jevObservationReferences: { hashes: [batchPlan.observationHash], complete: true },
    },
  })
  const controllerPasses = [
    batchPass,
    ...Result.getOrThrow(registeredSchedule(registration))
      .filter((item) => item.class === ObligationClass.Decision)
      .map((window, index) =>
        Schema.decodeUnknownSync(ControllerPassEvidenceSchema)({
          controllerKey: identity.identityHash,
          planHash: registration.obligations.configuration.controllerPlanHash,
          epoch: 1,
          sequence: index + 1,
          receiptHash: testHash({ window: window.obligationId }),
          completedAt: window.dueAt,
          observation: {
            result: 'SUCCESS',
            outcome: 'WINDOW_CLOSED',
            executionIssuedAt: window.dueAt,
            observedAt: window.dueAt,
            jevObservationReferences: { hashes: [], complete: true },
          },
        }),
      ),
  ]
  const event = (intentId: string, sequence: number, eventType: MutationEventType, offset: number) =>
    Schema.decodeUnknownSync(MutationEventSchema)({
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: testHash({ intentId, sequence }),
      mutationId: testHash({ intentId }),
      intentId,
      sequence,
      operation: 'SUBMIT',
      eventType,
      requestHash: testHash({ request: intentId }),
      consistencyDelayMs: 1000,
      occurredAt: at(offset),
      ...(sequence === 2 ? { routing: { startedAt: at(3), requestDispatchedAt: at(4), completedAt: at(offset) } } : {}),
    })
  const mutations = document.orderedIntentIds
    .flatMap((intentId) => [
      event(intentId, 1, MutationEventType.SubmitStarted, 2),
      event(intentId, 2, MutationEventType.SubmitUnknown, 10),
      event(intentId, 3, MutationEventType.RecoveryFound, 1000),
    ])
    .map((event) => ({
      authorityGenerationHash: document.bindings.authorityGenerationHash,
      strategyDecisionHash: document.bindings.strategyDecisionHash,
      event,
    }))
  const witness = (kind: SystemSourceCut['durableObservations'][number]['kind'], hash: string, sourceAt: string) => ({
    kind,
    sourceHash: hash,
    sourceAt,
    correct: true,
    witnessedAt: new Date(Date.parse(sourceAt) + 100).toISOString(),
  })
  const cut = Schema.decodeUnknownSync(SystemSourceCutSchema)({
    schemaVersion: 'bayn.system-source-cut.v2',
    registrationHash: testHash(registration),
    asOf: '2026-12-01T00:00:00.000Z',
    runtimeConfigurationHash: registration.obligations.runtimeConfigurationHash,
    financial: [
      {
        policy: 'JEV',
        sourceHash: testHash('financial'),
        accountBindingHash,
        definitionHash: testHash('definition'),
        cashHistory: null,
        sessions: [],
      },
    ],
    inference: [],
    inferenceLedgerEvidenceHash: testHash('inference'),
    batches: [{ plan: batchPlan, result: batchResult, observation }],
    decisions: [{ sessionDate: session.date, document }],
    mutations,
    fills: [],
    accountMarks: [],
    controllerPasses,
    durableObservations: [
      witness('BATCH', batchResult.resultHash, batchResult.completedAt),
      witness('DECISION', document.contentHash, document.createdAt),
      ...controllerPasses.map((p) => witness('CONTROLLER', p.receiptHash, p.completedAt)),
      ...mutations.map(({ event }) => witness('MUTATION', event.eventId, event.occurredAt)),
    ],
    sourceMaterial: {},
    sourceMaterialHash: testHash({}),
  })
  return {
    cut,
    registration,
    identity,
    at,
    witness,
    batchPass,
    measure: (source = cut) => Result.getOrThrow(measureFullBatchLatency(registration, source, identity)),
  }
}

export const nativeLatencyBacktestFixture = (
  f: ReturnType<typeof fullBatchLatencyFixture>,
  image?: { imageRepository: string; imageDigest: string },
  policy: NativeReplayPolicy = JevResearchPolicy.Candidate,
  manifest: BacktestSourceManifest = retainedReplayFixture().manifest,
) => {
  const first = f.registration.calendar.sessions[0]
  const last = f.registration.calendar.sessions.at(-1)
  if (first === undefined || last === undefined) throw new Error('Missing registered sessions')
  const localTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const calendar = f.registration.calendar.sessions.map((s) => {
    const open = localTime.format(new Date(s.openAt))
    const close = localTime.format(new Date(s.closeAt))
    return {
      date: s.sessionDate,
      open,
      close,
      session_open: open.replace(':', ''),
      session_close: close.replace(':', ''),
    }
  })
  const normalized = Result.getOrThrow(
    normalizeMarketCalendarResult(calendar, { start: first.sessionDate, end: last.sessionDate }),
  )
  const retained = manifest
  const sourceMaterial = {
    ...retained,
    coverageStartMs: Math.min(retained.coverageStartMs, Date.parse(first.openAt)),
    coverageEndMs: Math.max(retained.coverageEndMs, Date.parse(last.closeAt)),
    marketSources: Schema.decodeUnknownSync(MarketSourcesSchema)(
      f.registration.obligations.configuration.protocol.marketProfiles.map((profile) => ({
        universeId: profile.universeId,
        universeSymbolHash: profile.universeSymbolHash,
        symbols: profile.universe,
        topics: { ...profile.sourceTopics, features: profile.streamingInput.featureTopic },
      })),
    ),
  }
  const source = {
    ...sourceMaterial,
    positions: backtestSourcePartitions(sourceMaterial).map(
      ({ topic, partition }) =>
        retained.positions.find((position) => position.topic === topic && position.partition === partition) ?? {
          topic,
          partition,
          startOffset: '0',
          endOffsetExclusive: '0',
        },
    ),
  }
  const capture = retainedReplayCaptureFixture(source)
  const { verification: _verification, ...configuredBuild } = config.build
  const selected = f.registration.policies.find((p) => p.policy === policy)
  if (selected === undefined) throw new Error('Missing registered replay policy')
  const policyIdentity = Result.getOrThrow(
    nativeReplayPolicyIdentity(policy, f.registration.obligations.configuration.protocol),
  )
  const build = {
    ...configuredBuild,
    ...image,
    strategyBehaviorHash: policyIdentity.strategy.behaviorHash,
    strategyParameterHash: policyIdentity.strategy.parameterHash,
  }
  const recording = {
    schemaVersion: 'bayn.replay-inference-recording.v1',
    sourceManifestHash: testHash(source),
    sourceRevision: build.sourceRevision,
    strategyBehaviorHash: build.strategyBehaviorHash,
    strategyParameterHash: build.strategyParameterHash,
    jevInstructionsHash: testHash(jevInstructions),
    calls: [],
  }
  const assumptions = {
    instruments: replayTestInstruments,
    latencyMs: 0,
    slippageBps: 0,
    availableLiquidityPpm: 1000000,
    feeMultiplierPpm: 1000000,
  }
  const material = Result.getOrThrow(
    latencyReplayPolicyMaterial(
      f.registration.obligations.configuration.protocol,
      selected.riskPolicy.accountId,
      policy,
    ),
  )
  const inferenceTariff = {
    jev: { inputMicrosPerMillionTokens: '42000', outputMicrosPerMillionTokens: '0' },
    chart: {
      inputMicrosPerMillionTokens: '100000',
      outputMicrosPerMillionTokens: '0',
      cachedInputMicrosPerMillionTokens: '0',
      cacheWriteInputMicrosPerMillionTokens: '0',
    },
  }
  const registration = withRegistrationCommitments({
    ...f.registration,
    calendar: { ...f.registration.calendar, sourceHash: testHash(normalized) },
    latencyReplayExecutionModelHash: Result.getOrThrow(
      latencyReplayExecutionModelHash({ assumptions, fractionalTrading: false }),
    ),
    policies: f.registration.policies.map((p) =>
      p.policy !== policy
        ? p
        : {
            ...p,
            sourceRevision: build.sourceRevision,
            imageDigest: build.imageDigest.slice('sha256:'.length),
            strategyHash: build.strategyBehaviorHash,
            parametersHash: build.strategyParameterHash,
            protocolHash: policyIdentity.protocolHash,
            riskPolicyHash: testHash(material.riskPolicy),
            riskPolicy: material.riskPolicy,
            inferenceRateCard: replayRateCardFixture(inferenceTariff),
            promptsHash: testHash(material.prompts),
            continuationAndExitsHash: testHash(material.continuationAndExits),
            executionModelHash: testHash(f.registration.obligations.configuration.protocol.executionModel),
          },
    ),
  })
  const cut = { ...f.cut, registrationHash: testHash(registration) }
  const configuration = registration.obligations.configuration
  const input = Schema.decodeUnknownSync(BacktestInputSchema)({
    schemaVersion: 'bayn.backtest.v9',
    policy,
    latencyStress: { registration, sourceCut: cut, brokerIdentity: f.identity },
    jevInstructionsHash: testHash(jevInstructions),
    inference: {
      mode: 'retained-responses',
      recording,
      recordingHash: testHash(recording),
      maximumCalls: 100,
      models: { jev: 'jev-1.13.0', chart: 'gpt-6-luna' },
      inputDefinition: 'bayn.jev-entry-state.v22',
      costs: inferenceTariff,
    },
    allocatedDataCostPerSessionMicros: '0',
    replicate: 'stress-artifact-fixture',
    interval: { startAt: first.openAt, endAt: last.closeAt },
    source,
    openingCashMicros: '100000000000',
    fractionalTrading: false,
    calendar: [
      ...calendar,
      { date: '2026-11-30', open: '09:30', close: '16:00', session_open: '0930', session_close: '1600' },
    ],
    assets: f.registration.obligations.configuration.protocol.universe.map((symbol, index) => ({
      id: `12345678-1234-4234-8234-${String(index).padStart(12, '0')}`,
      symbol,
      class: instrumentMarket(symbol) === MarketKind.Equity ? 'us_equity' : 'crypto',
      exchange: instrumentMarket(symbol) === MarketKind.Equity ? 'NASDAQ' : 'CRYPTO',
      status: 'active',
      tradable: true,
      fractionable: true,
      ...(instrumentMarket(symbol) === MarketKind.Crypto
        ? { min_order_size: '0.00001', min_trade_increment: '0.000000001', price_increment: '0.01' }
        : {}),
    })),
    assetObservationAt: first.openAt,
    assetObservationPolicy: 'retained-as-of-session',
    build,
    assumptions,
    cadence: {
      pollIntervalMs: configuration.cyclePollIntervalMs,
      reconciliationIntervalMs: configuration.reconciliationIntervalMs,
      reconciliationPassTimeoutMs: configuration.operationTimeoutMs,
      reconciliationStaleThresholdMs: configuration.reconciliationStaleThresholdMs,
    },
  })
  const prepared = Result.getOrThrowWith(prepareBacktest(input, capture), (cause) => cause)
  return { input, prepared, registration, cut, capture, source, first, last }
}
