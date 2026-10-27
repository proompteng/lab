import { describe, expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import { ControllerPassEvidenceSchema } from './decision-work'
import { measureControllerLatency, nearestRank95 } from './controller-latency'
import { registrationFixture, testHash, withRegistrationCommitments } from './fixtures.test-support'
import { ObligationClass } from './reliability'
import { registeredSchedule } from './schedule'
import { SystemSourceCutSchema, type SystemSourceCut } from './source-cut'

const fixture = () => {
  const identity = Result.getOrThrow(
    makeBrokerIdentity({
      schemaVersion: 'bayn.broker-identity.v2',
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      accountId: 'controller-timing-test',
    }),
  )
  const accountBindingHash = testHash({
    schemaVersion: 'bayn.inference-cost-account.v1',
    accountId: identity.accountId,
  })
  const base = registrationFixture()
  const registration = withRegistrationCommitments({
    ...base,
    policies: base.policies.map((policy) => (policy.policy === 'JEV' ? { ...policy, accountBindingHash } : policy)),
  })
  const windows = Result.getOrThrow(registeredSchedule(registration)).filter(
    (window) => window.class === ObligationClass.Decision,
  )
  const controllerPasses = windows.map((window, index) => {
    const durationMs = index < 18 ? index + 1 : index === 18 ? 5000 : 10000
    const completedAt = new Date(Date.parse(window.dueAt) + durationMs).toISOString()
    return Schema.decodeUnknownSync(ControllerPassEvidenceSchema)({
      controllerKey: identity.identityHash,
      planHash: registration.obligations.configuration.controllerPlanHash,
      epoch: 1,
      sequence: index,
      receiptHash: testHash({ index }),
      completedAt,
      observation: {
        executionIssuedAt: window.dueAt,
        observedAt: completedAt,
        ...(index < 18
          ? { result: 'SUCCESS', outcome: 'WINDOW_CLOSED' }
          : { result: 'FAILURE', operation: 'run-cycle-pass', failure: 'operational', message: 'Recorded failure' }),
      },
    })
  })
  const cut = Schema.decodeUnknownSync(SystemSourceCutSchema)({
    schemaVersion: 'bayn.system-source-cut.v3',
    decisionAdmissions: [],
    orders: [],
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
    decisions: [],
    batches: [],
    mutations: [],
    fills: [],
    accountMarks: [],
    controllerPasses,
    durableObservations: controllerPasses.map((pass) => ({
      kind: 'CONTROLLER',
      sourceHash: pass.receiptHash,
      sourceAt: pass.completedAt,
      correct: true,
      witnessedAt: new Date(Date.parse(pass.completedAt) + 100).toISOString(),
    })),
    sourceMaterial: {},
    sourceMaterialHash: testHash({}),
  })
  const measure = (replacement: SystemSourceCut = cut) =>
    Result.getOrThrow(measureControllerLatency(registration, replacement, identity))
  return { registration, identity, cut, measure }
}

describe('captured controller latency', () => {
  test('retains waiting and failing work, with separate measured completion and durable visibility', () => {
    const { measure } = fixture()
    const report = measure()
    expect(report).toMatchObject({
      status: 'MEASURED',
      scheduledWindowCount: 20,
      observedWindowCount: 20,
      p95CommandThroughCompletionMs: 5000,
      p95CommandThroughDurableVisibilityMs: 5100,
      missing: [],
      violations: [],
      unobservedWindows: [],
    })
    expect(report.samples.filter((sample) => sample.result === 'FAILURE')).toHaveLength(2)
    expect(report.samples.filter((sample) => sample.disposition === 'WINDOW_CLOSED')).toHaveLength(18)
  })

  test('unstarted work, missing original clocks, and unwitnessed completion cannot yield a complete p95', () => {
    const { cut, measure } = fixture()
    for (const controllerPasses of [
      cut.controllerPasses.slice(1),
      cut.controllerPasses.map((pass) => {
        const { executionIssuedAt: _issuedAt, ...observation } = pass.observation
        return { ...pass, observation }
      }),
      [],
    ]) {
      const report = measure({ ...cut, controllerPasses })
      expect(report.status).toBe('INCOMPLETE')
      expect(report.p95CommandThroughCompletionMs).toBeNull()
      expect(report.unobservedWindows.length).toBeGreaterThan(0)
    }
    const unwitnessed = measure({ ...cut, durableObservations: [] })
    expect(unwitnessed.status).toBe('INCOMPLETE')
    expect(unwitnessed.p95CommandThroughDurableVisibilityMs).toBeNull()
    expect(unwitnessed.observedWindowCount).toBe(20)
  })

  test('late completion stays in the original session and retries do not cover a later missing window', () => {
    const { cut, measure } = fixture()
    const pass = cut.controllerPasses[0]
    if (pass === undefined) throw new Error('Missing pass')
    const completedAt = '2026-11-03T14:31:03.000Z'
    const late = { ...pass, completedAt, observation: { ...pass.observation, observedAt: completedAt } }
    const report = measure({
      ...cut,
      controllerPasses: [late, late, ...cut.controllerPasses.slice(2)],
      durableObservations: [
        {
          kind: 'CONTROLLER',
          sourceHash: pass.receiptHash,
          sourceAt: completedAt,
          witnessedAt: completedAt,
          correct: true,
        },
        ...cut.durableObservations.slice(2),
      ],
    })
    expect(report.status).toBe('INCOMPLETE')
    expect(report.observedWindowCount).toBe(19)
    expect(report.samples[0]?.sessionDate).toBe('2026-11-02')
    expect(report.samples[0]?.commandThroughCompletionMs).toBe(86_401_000)
  })

  test('the last scheduled command cannot close the evaluation before the registered session ends', () => {
    const { cut, registration, measure } = fixture()
    const last = registration.calendar.sessions.at(-1)
    if (last === undefined) throw new Error('Missing final session')
    const report = measure({ ...cut, asOf: new Date(Date.parse(last.closeAt) - 1).toISOString() })
    expect(report.observedWindowCount).toBe(report.scheduledWindowCount)
    expect(report.status).toBe('INCOMPLETE')
    expect(report.missing).toContain('REGISTERED_WINDOW_NOT_COMPLETE')
    expect(report.p95CommandThroughCompletionMs).toBeNull()
  })

  test('duplicate receipts do not change the distribution, while conflicting receipts invalidate it', () => {
    const { cut, measure } = fixture()
    const pass = cut.controllerPasses[0]
    if (pass === undefined) throw new Error('Missing pass')
    expect(measure({ ...cut, controllerPasses: [...cut.controllerPasses, pass] }).samples).toEqual(measure().samples)
    const report = measure({ ...cut, controllerPasses: [...cut.controllerPasses, { ...pass, sequence: 999 }] })
    expect(report.status).toBe('VIOLATED')
    expect(report.p95CommandThroughCompletionMs).toBeNull()
  })

  test('foreign controller identity, reversed clocks and future witnesses cannot provide timing evidence', () => {
    const { cut, measure, registration, identity } = fixture()
    const foreign = measure({
      ...cut,
      controllerPasses: cut.controllerPasses.map((pass) => ({ ...pass, controllerKey: testHash('foreign') })),
    })
    expect(foreign.status).toBe('VIOLATED')
    const reversed = measure({
      ...cut,
      controllerPasses: cut.controllerPasses.map((pass) => ({
        ...pass,
        observation: { ...pass.observation, executionIssuedAt: cut.asOf },
      })),
    })
    expect(reversed.p95CommandThroughCompletionMs).toBeNull()
    const missing = measure({
      ...cut,
      durableObservations: cut.durableObservations.map((witness) => ({
        ...witness,
        witnessedAt: '2026-12-02T00:00:00.000Z',
      })),
    })
    expect(missing.status).toBe('INCOMPLETE')
    expect(
      Result.isFailure(
        measureControllerLatency(registration, { ...cut, registrationHash: testHash('other attempt') }, identity),
      ),
    ).toBe(true)
  })

  test('nearest-rank p95 is discrete, permutation invariant, and never supplies an empty or invalid sample', () => {
    for (const count of [1, 2, 19, 20, 21, 99, 100, 101, 1000]) {
      const sample = Array.from({ length: count }, (_, index) => index)
      expect(nearestRank95(sample.toReversed())).toBe(Math.ceil(count * 0.95) - 1)
    }
    for (const sample of [[], [-1], [0.5], [NaN], [Infinity], [Number.MAX_SAFE_INTEGER + 1]])
      expect(nearestRank95(sample)).toBeNull()
  })
})
