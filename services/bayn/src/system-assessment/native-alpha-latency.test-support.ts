import { Result, Schema } from 'effect'

import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import { JevResearchPolicy } from '../jev/acceptance'
import { IsoDateSchema } from '../schemas'
import { decideIntradayAlphaEntry } from '../strategy/intraday-alpha/decision'
import { makeOwnedIntradayAlphaObservation } from '../strategy/intraday-alpha/observation'
import {
  makeAlphaStreamingSnapshot,
  makeFlatAlphaPortfolio,
  makeTestTrailingBaseline,
} from '../strategy/intraday-alpha/test-support'
import { ControllerPassEvidenceSchema } from './decision-work'
import {
  nativeRegistrationFixture,
  registrationFixture,
  testHash,
  withRegistrationCommitments,
} from './fixtures.test-support'
import { ObligationClass } from './reliability'
import { registeredSchedule } from './schedule'
import { StrategyBoundSystemSourceCutSchema } from './source-cut'
import { ResearchStrategyEngine } from './strategy-binding'
import { strategyBoundRegistrationFixture } from './strategy-registration.test-support'

export const alphaLatencyFixture = (
  engines: Parameters<typeof strategyBoundRegistrationFixture>[1] = {},
  trailingBaseline = makeTestTrailingBaseline(),
) => {
  const calendar = Result.getOrThrow(
    normalizeMarketCalendarResult(
      ['2026-09-04', '2026-09-08'].map((date) => ({
        date: Schema.decodeUnknownSync(IsoDateSchema)(date),
        open: '09:30',
        close: '16:00',
        session_open: '0930',
        session_close: '1600',
      })),
      { start: '2026-09-04', end: '2026-09-08' },
    ),
  )
  const base = registrationFixture(undefined, 2)
  const bound = strategyBoundRegistrationFixture(
    nativeRegistrationFixture(
      {
        ...base,
        registeredAt: '2026-09-01T00:00:00.000Z',
      },
      calendar,
    ),
    engines,
  )
  const registration = withRegistrationCommitments({
    ...bound,
    policies: bound.policies.map((definition) => ({
      ...definition,
      inferenceRateCard: {
        ...definition.inferenceRateCard,
        rates: definition.inferenceRateCard.rates.map((rate) => ({
          ...rate,
          effectiveFrom: '2026-09-01T00:00:00.000Z',
          effectiveUntil: '2026-09-09T00:00:00.000Z',
        })),
      },
    })),
  })
  const candidate = registration.policies.find((p) => p.policy === JevResearchPolicy.Candidate)
  if (candidate === undefined || candidate.strategyBinding.engine !== ResearchStrategyEngine.IntradayAlpha)
    throw new Error('Expected explicit alpha candidate')
  const executionBuild = {
    sourceRevision: candidate.sourceRevision,
    imageRepository: candidate.capitalAuthorization?.buildLineage.activation.imageRepository ?? 'registry.example/bayn',
    imageDigest: `sha256:${candidate.imageDigest}`,
  }
  const snapshot = makeAlphaStreamingSnapshot({ minutesFromOpen: 60, profiles: {}, snapshotCalendar: calendar })
  const owned = Result.getOrThrow(
    makeOwnedIntradayAlphaObservation({
      cycleId: testHash('alpha timing cycle'),
      authorityGenerationHash: candidate.authorityGenerationHash,
      protocol: candidate.strategyBinding.parameters.sharedProtocol,
      portfolio: makeFlatAlphaPortfolio(snapshot.observedAt, undefined, undefined, candidate.riskPolicy.accountId),
      trailingBaseline,
      snapshot: snapshot.snapshot,
    }),
  )
  const at = (delta: number) => new Date(Date.parse(snapshot.observedAt) + delta).toISOString()
  const target = Result.getOrThrow(
    decideIntradayAlphaEntry(
      {
        schemaVersion: 'bayn.intraday-alpha-evidence.v2',
        observation: owned.payload,
        morningOrbTakenSymbols: [],
        middayReversionCompleted: false,
        noiseAreaTakenSymbols: [],
        catalystVetos: [],
        decidedAt: at(5),
      },
      candidate.strategyBinding.parameters,
    ),
  )
  if (target.selectedSymbols.length !== 0) throw new Error('Expected verified no-signal alpha target')
  const identity = Result.getOrThrow(
    makeBrokerIdentity({
      schemaVersion: 'bayn.broker-identity.v2',
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      accountId: candidate.riskPolicy.accountId,
    }),
  )
  const pass = Schema.decodeUnknownSync(ControllerPassEvidenceSchema)({
    controllerKey: identity.identityHash,
    planHash: registration.obligations.configuration.controllerPlanHash,
    epoch: 1,
    sequence: 0,
    receiptHash: testHash('alpha pass'),
    completedAt: at(10),
    observation: {
      result: 'SUCCESS',
      outcome: 'RECOVERED',
      recoveryAction: 'WAITING',
      readiness: { reason: 'NO_ELIGIBLE_CANDIDATE', message: 'Verified empty alpha selection' },
      entryAbstention: target,
      executionBuild,
      executionIssuedAt: at(-10),
      observedAt: at(10),
      alphaObservationReferences: { hashes: [owned.contentHash], complete: true },
    },
  })
  const passes = [
    pass,
    ...Result.getOrThrow(registeredSchedule(registration))
      .filter((window) => window.class === ObligationClass.Decision)
      .map((window, index) =>
        Schema.decodeUnknownSync(ControllerPassEvidenceSchema)({
          controllerKey: identity.identityHash,
          planHash: registration.obligations.configuration.controllerPlanHash,
          epoch: 1,
          sequence: index + 1,
          receiptHash: testHash(window.obligationId),
          completedAt: window.dueAt,
          observation: {
            result: 'SUCCESS',
            outcome: 'ACQUIRED',
            executionBuild,
            observedAt: window.dueAt,
            executionIssuedAt: window.dueAt,
            alphaObservationReferences: { hashes: [], complete: true },
          },
        }),
      ),
  ]
  const cut = Schema.decodeUnknownSync(StrategyBoundSystemSourceCutSchema)({
    schemaVersion: 'bayn.system-source-cut.v5',
    registrationHash: testHash(registration),
    runtimeConfigurationHash: registration.obligations.runtimeConfigurationHash,
    asOf: '2026-09-09T00:00:00.000Z',
    financial: [
      {
        policy: JevResearchPolicy.Candidate,
        sourceHash: testHash('financial'),
        accountBindingHash: candidate.accountBindingHash,
        definitionHash: testHash('definition'),
        cashHistory: null,
        sessions: [],
      },
    ],
    inference: [],
    inferenceLedgerEvidenceHash: testHash('inference'),
    protectionIntents: [],
    decisions: [],
    batches: [],
    decisionAdmissions: [],
    mutations: [],
    fills: [],
    orders: [],
    accountMarks: [],
    controllerPasses: passes,
    alphaObservations: [{ contentHash: owned.contentHash, payload: owned.payload }],
    durableObservations: [
      {
        kind: 'ALPHA_OBSERVATION',
        sourceHash: owned.contentHash,
        sourceAt: owned.payload.observedAt,
        witnessedAt: at(100),
        correct: true,
      },
      ...passes.map((p) => ({
        kind: 'CONTROLLER',
        sourceHash: p.receiptHash,
        sourceAt: p.completedAt,
        witnessedAt: new Date(Date.parse(p.completedAt) + 100).toISOString(),
        correct: true,
      })),
    ],
    sourceMaterial: {},
    sourceMaterialHash: testHash({}),
  })
  return { registration, identity, cut, owned, pass, at, executionBuild }
}
