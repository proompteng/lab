import { expect, test } from 'bun:test'
import { Cause, Effect, Exit, Option, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { BrokerRead, type BrokerReadShape } from '../../broker/alpaca/model'
import { canonicalHashV1Result } from '../../hash'
import { nativeJevFixture } from '../../jev/native.test-support'
import { executionMarketDataBinding } from '../../observe-composition/intraday-market-data'
import { makeObserveShadowDecisionDocument } from '../../shadow-decision-contract'
import { TargetPlanReason, TargetPlanStatus } from '../../target-planner/index'
import { CycleState, CycleTerminalReason, type AutonomousCycle } from '../model'
import { selectCycleRecovery } from './recovery-selection'
import { CycleStore, CycleStoreError, type CycleStoreShape } from '../store/model'
import { decideBlock, decideDecisionBinding, makeInitialCycle } from '../store/decisions'
import { discoverAutonomousCyclePass, runAutonomousCyclePass } from './program'

const cutoffAt = '2026-09-04T19:55:00.000Z'
const beforeCutoff = '2026-09-04T19:54:59.000Z'

test.each(
  [cutoffAt, '2026-09-04T19:55:00.001Z'].flatMap((bindAt) =>
    [
      { expiresDuringBinding: false, rollbackFailure: undefined },
      { expiresDuringBinding: true, rollbackFailure: undefined },
      ...(['query', 'defect', 'interruption'] as const).map((rollbackFailure) => ({
        expiresDuringBinding: true,
        rollbackFailure,
      })),
    ].map((mode) => ({ bindAt, ...mode })),
  ),
)(
  'binding at $bindAt preserves expiry and rollback outcomes (database expiry=$expiresDuringBinding, rollback=$rollbackFailure)',
  async ({ bindAt, expiresDuringBinding, rollbackFailure }) => {
    const native = nativeJevFixture(undefined, beforeCutoff)
    const cycle = { ...makeInitialCycle(native.draft, beforeCutoff), state: CycleState.Active, stateVersion: 2 }
    expect(cycle.window.submissionCutoffAt).toBe(cutoffAt)
    const marketData = Result.getOrThrow(executionMarketDataBinding(native.snapshot))
    const targetMaterial = {
      schemaVersion: 'bayn.paper-reference-target-plan.v1' as const,
      inputHash: '1'.repeat(64),
      status: TargetPlanStatus.NoTrade,
      reason: TargetPlanReason.TargetsSatisfied,
      targets: [
        {
          symbol: 'AAPL',
          targetWeight: 0,
          referencePriceMicros: '100000000',
          currentQuantityAtoms: '0',
          targetQuantityAtoms: '0',
        },
      ],
      intentTargets: [],
      requiredReferenceBuyNotionalMicros: '0',
      availableBuyingPowerMicros: '0',
      residualBuyingPowerMicros: '0',
    }
    const document = Result.getOrThrow(
      makeObserveShadowDecisionDocument({
        schemaVersion: 'bayn.observe-shadow-decision.v2',
        mode: 'OBSERVE',
        dispatchable: false,
        bindings: {
          strategyName: cycle.identity.strategyName,
          cycleId: cycle.identity.cycleId,
          strategyProtocolHash: cycle.identity.strategyProtocolHash,
          accountId: cycle.identity.accountId,
          snapshotId: marketData.snapshotId,
          snapshotContentHash: marketData.contentHash,
          snapshotFinalizedAt: marketData.observedAt,
          executionMarketData: marketData,
          strategyDecisionHash: '2'.repeat(64),
          policyHash: '3'.repeat(64),
          planningBrokerStateHash: '4'.repeat(64),
          reconciliationId: '5'.repeat(64),
          reconciliationHash: '6'.repeat(64),
        },
        targetPlan: { ...targetMaterial, outputHash: Result.getOrThrow(canonicalHashV1Result(targetMaterial)) },
        deltaRisk: [],
        createdAt: beforeCutoff,
        submissionCutoffAt: cutoffAt,
        expiresAt: cutoffAt,
      }),
    )
    expect(Result.getOrThrow(decideDecisionBinding(cycle, document, beforeCutoff, []))._tag).toBe('Persist')
    const bound = { ...cycle, bindings: { snapshotId: marketData.snapshotId, decisionHash: document.contentHash } }
    expect(Result.getOrThrow(decideDecisionBinding(bound, document, bindAt, [document]))._tag).toBe('Replay')
    expect(
      Result.getOrThrow(
        decideDecisionBinding({ ...cycle, bindings: { snapshotId: marketData.snapshotId } }, document, bindAt, []),
      ),
    ).toMatchObject({
      _tag: 'Block',
      reason: CycleTerminalReason.MissedSubmission,
    })
    expect(
      Result.getOrThrow(
        selectCycleRecovery({
          cycleBindingId: cycle.identity.qualificationRunId,
          accountId: cycle.identity.accountId,
          strategyProtocolHash: cycle.identity.strategyProtocolHash,
          cycle,
          decisionDocument: document,
          observedAt: bindAt,
        }),
      ),
    ).toMatchObject({ action: 'BLOCK', reason: CycleTerminalReason.MissedSubmission })
    const forbidden = () => Effect.die(new Error('unexpected cutoff recovery side effect'))
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
    let latest: AutonomousCycle = cycle
    let acquisitions = 0
    const operations: string[] = []
    const expired = Cause.fail(
      new CycleStoreError({
        operation: 'bind-decision',
        failure: 'entry-expired',
        persistenceFailure: 'constraint',
        message: 'entry admission expired in PostgreSQL',
      }),
    )
    const cleanup =
      rollbackFailure === undefined
        ? undefined
        : rollbackFailure === 'query'
          ? Cause.fail(
              new CycleStoreError({ operation: 'bind-decision', failure: 'query', message: 'rollback failed' }),
            )
          : rollbackFailure === 'defect'
            ? Cause.die(new Error('rollback defect'))
            : Cause.interrupt()
    const store: CycleStoreShape = {
      read: forbidden,
      readOldestUnfinished: forbidden,
      activate: forbidden,
      finish: forbidden,
      block: (_id, reason, observedAt) =>
        Effect.sync(() => {
          expect(reason).toBe(CycleTerminalReason.UnusedEntryExpired)
          expect(observedAt).toBe(bindAt)
          operations.push('expire')
          latest = {
            ...cycle,
            state: CycleState.Blocked,
            stateVersion: 3,
            terminalReason: reason,
            terminalAt: observedAt,
            updatedAt: observedAt,
          }
          return { cycle: latest, changed: true }
        }),
      readAuthoritySlot: () => Effect.sync(() => Option.some(latest)),
      readDecisionDocument: () => Effect.succeed(Option.none()),
      acquire: (draft, observedAt) =>
        Effect.sync(() => {
          acquisitions += 1
          latest = makeInitialCycle(draft, observedAt)
          return { cycle: latest, created: true }
        }),
      bindDecision: (_id, input, observedAt) =>
        expiresDuringBinding
          ? TestClock.setTime(Date.parse(bindAt)).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  operations.push('bind')
                  expect(observedAt).toBe(beforeCutoff)
                }),
              ),
              Effect.andThen(Effect.failCause(cleanup === undefined ? expired : Cause.combine(expired, cleanup))),
            )
          : Effect.sync(() => {
              operations.push('bind')
              expect(observedAt).toBe(bindAt)
              const decision = Result.getOrThrow(decideDecisionBinding(cycle, input, observedAt, []))
              if (decision._tag !== 'Block') throw new Error('late decision must not bind')
              expect(Result.getOrThrow(decideBlock(cycle, decision.reason, observedAt))._tag).toBe('Persist')
              latest = {
                ...cycle,
                state: CycleState.Blocked,
                stateVersion: 3,
                terminalReason: decision.reason,
                terminalAt: observedAt,
                updatedAt: observedAt,
              }
              return { cycle: latest, changed: true }
            }),
    }
    if (cycle.identity.executionPolicy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3')
      throw new Error('expected current execution policy')
    const context = {
      cycleBindingId: cycle.identity.qualificationRunId,
      strategyName: 'jev' as const,
      strategyProtocolHash: cycle.identity.strategyProtocolHash,
      accountId: cycle.identity.accountId,
      executionPolicy: cycle.identity.executionPolicy,
      authorityGenerationHash: '7'.repeat(64),
      buildDecision: () =>
        Effect.sync(() => {
          operations.push('build')
          return document
        }),
      buildDecisionEvidence: () =>
        TestClock.setTime(Date.parse(expiresDuringBinding ? beforeCutoff : bindAt)).pipe(
          Effect.andThen(
            Effect.sync(() => {
              operations.push('verify')
              return {}
            }),
          ),
        ),
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(beforeCutoff))
        if (rollbackFailure !== undefined) {
          const result = yield* runAutonomousCyclePass(context, cycle).pipe(Effect.exit)
          expect(Exit.isFailure(result)).toBe(true)
          if (Exit.isSuccess(result)) throw new Error('rollback failure must not become normal expiry')
          expect(result.cause.reasons).toHaveLength(2)
          expect(result.cause.reasons[1]?._tag).toBe(
            rollbackFailure === 'query' ? 'Fail' : rollbackFailure === 'defect' ? 'Die' : 'Interrupt',
          )
          expect(latest).toBe(cycle)
          return
        }
        const result = yield* runAutonomousCyclePass(context, cycle)
        expect(result).toMatchObject({
          outcome: 'RECOVERED',
          action: 'BLOCKED',
          cycle: {
            terminalReason: CycleTerminalReason.UnusedEntryExpired,
            bindings: {},
          },
        })
        const prior = latest
        const { authorityGenerationHash: _, ...unapproved } = context
        yield* TestClock.setTime(Date.parse(bindAt) + 60_000)
        expect((yield* discoverAutonomousCyclePass(unapproved)).outcome).toBe('ALREADY_TERMINAL')
        yield* TestClock.setTime(Date.parse(bindAt) + 59_999)
        expect((yield* discoverAutonomousCyclePass(context)).outcome).toBe('ALREADY_TERMINAL')
        yield* TestClock.setTime(Date.parse(bindAt) + 60_000)
        const successor = yield* discoverAutonomousCyclePass(context)
        expect(successor).toMatchObject({
          outcome: 'ACQUIRED',
          receipt: {
            cycle: {
              identity: { entryAttemptOrdinal: 2 },
              window: { executionCalendarSchemaVersion: 'bayn.continuous-market-hours.v1' },
              bindings: {},
            },
          },
        })
        expect(prior.terminalReason).toBe(CycleTerminalReason.UnusedEntryExpired)
        expect(latest.identity.cycleId).not.toBe(prior.identity.cycleId)
      }).pipe(
        Effect.provideService(BrokerRead, broker),
        Effect.provideService(CycleStore, store),
        Effect.provide(TestClock.layer()),
      ),
    )
    expect(operations).toEqual(
      expiresDuringBinding && rollbackFailure === undefined
        ? ['build', 'verify', 'bind', 'expire']
        : ['build', 'verify', 'bind'],
    )
    expect(acquisitions).toBe(rollbackFailure === undefined ? 1 : 0)
  },
)
