import { beforeAll, expect, test } from 'bun:test'
import { Cause, Effect, Exit, Option, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'

import { BrokerRead, type BrokerReadShape } from '../../broker/alpaca/model'
import { RiskOutcome } from '../../execution/contracts'
import { ExpiredIntentRiskDecision } from '../../execution/risk-clock'
import { nativeJevFixture } from '../../jev/native.test-support'
import { JevPurpose } from '../../jev/portfolio'
import type { ExecutionDecisionDocument } from '../../shadow-decision-contract'
import { makePersistenceDocumentFixture } from '../../system-assessment/decision-persistence.test-support'
import { unusedEntryExpiresAt } from '../entry-admission'
import { CycleState, CycleTerminalReason, type AutonomousCycle } from '../model'
import { makeInitialCycle } from '../store/decisions'
import { CycleStore, CycleStoreError, type CycleStoreShape } from '../store/model'
import { runAutonomousCyclePass } from './program'
import { DecisionReadinessReason, DecisionReadinessSchema } from './readiness'

const accountId = 'risk-expiry-runner-test'
const native = nativeJevFixture(JevPurpose.Entry, undefined, accountId)
const cycle = {
  ...makeInitialCycle(native.draft, native.observation.payload.observedAt),
  state: CycleState.Active,
  stateVersion: 2,
}
let document: ExecutionDecisionDocument

beforeAll(async () => {
  document = await Effect.runPromise(makePersistenceDocumentFixture(accountId))
  expect(document.bindings.cycleId).toBe(cycle.identity.cycleId)
  expect(document.dispatchable).toBe(true)
  expect(document.orderedIntentIds.length).toBeGreaterThan(0)
  expect(document.deltaRisk.every((risk) => risk.evaluation.decision.outcome === RiskOutcome.Approved)).toBe(true)
}, 30_000)

test.each([
  { name: 'before original deadline', atDeadline: false, failure: undefined },
  { name: 'at original deadline', atDeadline: true, failure: undefined },
  { name: 'blocking failure', atDeadline: true, failure: 'block' as const },
  ...(['query', 'defect', 'interruption', 'unverified'] as const).map((failure) => ({
    name: failure,
    atDeadline: false,
    failure,
  })),
])(
  'risk rejection recovery preserves the original cycle and rollback outcome: $name',
  async ({ atDeadline, failure }) => {
    const risk = document.deltaRisk[0]?.evaluation.decision
    const intentId = document.orderedIntentIds[0]
    if (risk === undefined || intentId === undefined) throw new Error('Missing approved risk fixture')
    const expires = unusedEntryExpiresAt(cycle)
    expect(Date.parse(risk.expiresAt)).toBeLessThan(expires)
    const checkedAt = new Date(atDeadline ? expires : Date.parse(risk.expiresAt)).toISOString()
    const evidence = {
      schemaVersion: 'bayn.intent-risk-clock-rejection.v1' as const,
      violation: 'EXPIRED' as const,
      intentId,
      decisionId: risk.decisionId,
      decidedAt: risk.decidedAt,
      expiresAt: risk.expiresAt,
      updatedAt: document.createdAt,
      checkedAt,
    }
    const expired = new ExpiredIntentRiskDecision({ evidence, cause: 'verified PostgreSQL rejection' })
    const rejection = new CycleStoreError({
      operation: 'bind-decision',
      failure: 'risk-expired',
      persistenceFailure: 'constraint',
      message: 'Risk approval expired in PostgreSQL',
      cause: failure === 'unverified' ? { _tag: 'ExpiredIntentRiskDecision', evidence, cause: expired.cause } : expired,
    })
    const cleanup =
      failure === 'query'
        ? Cause.fail(new CycleStoreError({ operation: 'bind-decision', failure: 'query', message: 'rollback failed' }))
        : failure === 'defect'
          ? Cause.die(new Error('rollback defect'))
          : failure === 'interruption'
            ? Cause.interrupt()
            : undefined
    const forbidden = () => Effect.die(new Error('unexpected trading or authority side effect'))
    const broker: BrokerReadShape = {
      account: forbidden(),
      accountConfiguration: forbidden(),
      positions: forbidden(),
      assetBySymbol: forbidden,
      orders: forbidden,
      orderById: forbidden,
      orderByClientId: forbidden,
      fillActivities: forbidden,
      feeActivities: forbidden,
      marketCalendar: forbidden,
    }
    const operations: string[] = []
    let stored: AutonomousCycle = cycle
    const store: CycleStoreShape = {
      read: forbidden,
      readOldestUnfinished: forbidden,
      acquire: forbidden,
      activate: forbidden,
      finish: forbidden,
      readAuthoritySlot: () => Effect.succeed(Option.some(stored)),
      readDecisionDocument: () => Effect.succeed(Option.none()),
      block: (_id, reason, observedAt) =>
        Effect.gen(function* () {
          expect(reason).toBe(CycleTerminalReason.UnusedEntryExpired)
          expect(observedAt).toBe(checkedAt)
          operations.push('block')
          if (failure === 'block')
            return yield* new CycleStoreError({ operation: 'block', failure: 'query', message: 'blocking failed' })
          stored = {
            ...stored,
            state: CycleState.Blocked,
            stateVersion: stored.stateVersion + 1,
            terminalReason: reason,
            terminalAt: observedAt,
            updatedAt: observedAt,
          }
          return { cycle: stored, changed: true }
        }),
      bindDecision: (id, input, observedAt) =>
        TestClock.setTime(Date.parse(checkedAt)).pipe(
          Effect.andThen(
            Effect.sync(() => {
              expect(id).toBe(cycle.identity.cycleId)
              expect(input).toBe(document)
              expect(observedAt).toBe(document.createdAt)
              operations.push('bind')
            }),
          ),
          Effect.andThen(
            Effect.failCause(
              cleanup === undefined ? Cause.fail(rejection) : Cause.combine(Cause.fail(rejection), cleanup),
            ),
          ),
        ),
    }
    const policy = cycle.identity.executionPolicy
    if (policy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3') throw new Error('Expected native policy')
    const context = {
      cycleBindingId: cycle.identity.qualificationRunId,
      strategyName: 'jev' as const,
      strategyProtocolHash: cycle.identity.strategyProtocolHash,
      accountId,
      executionPolicy: policy,
      authorityGenerationHash: document.bindings.authorityGenerationHash,
      buildDecision: () =>
        Effect.sync(() => {
          operations.push('build')
          return document
        }),
      buildDecisionEvidence: () => Effect.succeed({}),
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(document.createdAt))
        const result = yield* runAutonomousCyclePass(context, cycle).pipe(Effect.exit)
        if (failure !== undefined) {
          expect(Exit.isFailure(result)).toBe(true)
          if (Exit.isSuccess(result)) throw new Error('Unverified or failed rollback cannot become normal recovery')
          expect(result.cause.reasons).toHaveLength(cleanup === undefined ? 1 : 2)
          if (cleanup !== undefined)
            expect(result.cause.reasons[1]?._tag).toBe(
              failure === 'query' ? 'Fail' : failure === 'defect' ? 'Die' : 'Interrupt',
            )
          expect(stored).toBe(cycle)
          expect(operations).toEqual(failure === 'block' ? ['build', 'bind', 'block'] : ['build', 'bind'])
          return
        }
        if (Exit.isFailure(result)) throw new Error(Cause.pretty(result.cause))
        expect(result.value).toMatchObject({
          outcome: 'RECOVERED',
          action: atDeadline ? 'BLOCKED' : 'WAITING',
          observedAt: checkedAt,
        })
        expect(stored.identity).toBe(cycle.identity)
        expect(stored.createdAt).toBe(cycle.createdAt)
        expect(stored.window).toBe(cycle.window)
        expect(stored.bindings).toEqual({})
        if (atDeadline) {
          expect(stored.terminalReason).toBe(CycleTerminalReason.UnusedEntryExpired)
          expect(operations).toEqual(['build', 'bind', 'block'])
        } else {
          expect(result.value).toMatchObject({
            readiness: { reason: DecisionReadinessReason.ExecutionRiskExpired, riskClockRejection: evidence },
          })
          expect(stored).toBe(cycle)
          expect(operations).toEqual(['build', 'bind'])
        }
      }).pipe(
        Effect.provideService(BrokerRead, broker),
        Effect.provideService(CycleStore, store),
        Effect.provide(TestClock.layer()),
      ),
    )
  },
)

test('risk-expiry readiness requires verified expiry context rather than future or missing evidence', () => {
  const risk = document.deltaRisk[0]?.evaluation.decision
  const intentId = document.orderedIntentIds[0]
  if (risk === undefined || intentId === undefined) throw new Error('Missing risk fixture')
  const base = { reason: DecisionReadinessReason.ExecutionRiskExpired, message: 'Risk expired before binding' }
  const evidence = {
    schemaVersion: 'bayn.intent-risk-clock-rejection.v1',
    violation: 'EXPIRED',
    intentId,
    decisionId: risk.decisionId,
    decidedAt: risk.decidedAt,
    expiresAt: risk.expiresAt,
    updatedAt: document.createdAt,
    checkedAt: risk.expiresAt,
  }
  const decode = Schema.decodeUnknownResult(DecisionReadinessSchema)
  expect(Result.isFailure(decode(base))).toBe(true)
  expect(Result.isFailure(decode({ ...base, riskClockRejection: { ...evidence, violation: 'NOT_YET_VALID' } }))).toBe(
    true,
  )
  expect(Result.isSuccess(decode({ ...base, riskClockRejection: evidence }))).toBe(true)
})
