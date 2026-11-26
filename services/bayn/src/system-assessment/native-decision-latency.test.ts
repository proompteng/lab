import { describe, expect, test } from 'bun:test'
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
import { measureAlphaDecisionLatency, measureRegisteredDecisionLatency } from './native-decision-latency'
import { ObligationClass } from './reliability'
import { registeredSchedule } from './schedule'
import { StrategyBoundSystemSourceCutSchema } from './source-cut'
import { ResearchStrategyEngine } from './strategy-binding'
import { strategyBoundRegistrationFixture } from './strategy-registration.test-support'

const alphaLatencyFixture = () => {
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
  const registration = withRegistrationCommitments(
    strategyBoundRegistrationFixture(
      nativeRegistrationFixture(
        {
          ...base,
          registeredAt: '2026-09-01T00:00:00.000Z',
        },
        calendar,
      ),
    ),
  )
  const candidate = registration.policies.find((p) => p.policy === JevResearchPolicy.Candidate)
  if (candidate === undefined || candidate.strategyBinding.engine !== ResearchStrategyEngine.IntradayAlpha)
    throw new Error('Expected explicit alpha candidate')
  const snapshot = makeAlphaStreamingSnapshot({ minutesFromOpen: 60, profiles: {}, snapshotCalendar: calendar })
  const owned = Result.getOrThrow(
    makeOwnedIntradayAlphaObservation({
      cycleId: testHash('alpha timing cycle'),
      authorityGenerationHash: candidate.authorityGenerationHash,
      protocol: candidate.strategyBinding.parameters.sharedProtocol,
      portfolio: makeFlatAlphaPortfolio(snapshot.observedAt, undefined, undefined, candidate.riskPolicy.accountId),
      trailingBaseline: makeTestTrailingBaseline(),
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
  return { registration, identity, cut, owned, pass, at }
}

describe('native alpha command-to-durable-decision latency', () => {
  test('measures a reproduced alpha abstention without fabricating a Jev batch', () => {
    const f = alphaLatencyFixture()
    const result = Result.getOrThrow(measureRegisteredDecisionLatency(f.registration, f.cut, f.identity))
    expect(result).toMatchObject({
      schemaVersion: 'bayn.native-alpha-decision-latency.v1',
      engine: ResearchStrategyEngine.IntradayAlpha,
      status: 'MEASURED',
      p95FullBatchMs: 120,
      admittedObservationCount: 1,
      measuredObservationCount: 1,
      missing: [],
      violations: [],
    })
    expect(result.samples[0]).toMatchObject({ observationHash: f.owned.contentHash, failed: false, abstained: true })
    expect(f.cut.batches).toEqual([])
  })

  test.each([
    'observation witness',
    'command reference',
    'command witness',
    'unresolved decision',
    'source payload',
  ] as const)('%s absence withholds the complete percentile', (missing) => {
    const f = alphaLatencyFixture()
    const cut = {
      ...f.cut,
      alphaObservations: missing === 'source payload' ? [] : f.cut.alphaObservations,
      durableObservations: f.cut.durableObservations.filter((w) =>
        missing === 'observation witness'
          ? w.kind !== 'ALPHA_OBSERVATION'
          : missing === 'command witness'
            ? w.sourceHash !== f.pass.receiptHash
            : true,
      ),
      controllerPasses: f.cut.controllerPasses.map((pass) => {
        if (pass.receiptHash !== f.pass.receiptHash) return pass
        if (missing === 'command reference')
          return {
            ...pass,
            observation: { ...pass.observation, alphaObservationReferences: { hashes: [], complete: false } },
          }
        if (missing === 'unresolved decision')
          return {
            ...pass,
            observation: {
              result: 'SUCCESS' as const,
              outcome: 'ACQUIRED' as const,
              observedAt: f.at(10),
              executionIssuedAt: f.at(-10),
              alphaObservationReferences: { hashes: [f.owned.contentHash], complete: true },
            },
          }
        return pass
      }),
    }
    const result = Result.getOrThrow(measureAlphaDecisionLatency(f.registration, cut, f.identity))
    expect(result.status).not.toBe('MEASURED')
    expect(result.p95FullBatchMs).toBeNull()
    expect(result.missing.length).toBeGreaterThan(0)
  })

  test('failed native work remains in the timing sample and a delayed durable witness increases its bound', () => {
    const f = alphaLatencyFixture()
    const cut = {
      ...f.cut,
      controllerPasses: f.cut.controllerPasses.map((pass) =>
        pass.receiptHash !== f.pass.receiptHash
          ? pass
          : {
              ...pass,
              observation: {
                result: 'FAILURE' as const,
                executionIssuedAt: f.at(-10),
                observedAt: f.at(10),
                operation: 'build-decision' as const,
                failure: 'database' as const,
                message: 'Synthetic retained decision write failure',
                alphaObservationReferences: { hashes: [f.owned.contentHash], complete: true },
              },
            },
      ),
      durableObservations: f.cut.durableObservations.map((w) =>
        w.kind === 'ALPHA_OBSERVATION' ? { ...w, witnessedAt: f.at(5000) } : w,
      ),
    }
    const result = Result.getOrThrow(measureAlphaDecisionLatency(f.registration, cut, f.identity))
    expect(result.status).toBe('MEASURED')
    expect(result.p95FullBatchMs).toBe(5010)
    expect(result.samples[0]).toMatchObject({ failed: true, abstained: false })
  })

  test('a candidate cannot borrow an incumbent or different-policy observation', () => {
    const f = alphaLatencyFixture()
    const payload = { ...f.owned.payload, authorityGenerationHash: testHash('different generation') }
    const cut = { ...f.cut, alphaObservations: [{ payload, contentHash: testHash(payload) }] }
    const result = Result.getOrThrow(measureAlphaDecisionLatency(f.registration, cut, f.identity))
    expect(result.status).toBe('VIOLATED')
    expect(result.p95FullBatchMs).toBeNull()
    expect(result.violations.some((v) => v.startsWith('ALPHA_OBSERVATION_SCOPE_OR_CONTENT_MISMATCH:'))).toBe(true)
  })
})
