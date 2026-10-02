import { Deferred, Effect, Scope, Semaphore } from 'effect'
import type { AutonomousCycleStartup, AutonomousRuntime } from '../app'

import {
  advanceRestrictedGenerationRecovery,
  recognizeRestrictedGenerationRebind,
  type TerminalGenerationRolloverReceipt,
} from '../blocked-generation-recovery'
import { Authority, KillState, type AuthorityState } from '../execution/contracts'
import { isExecutionMandateRecoveryRestriction } from '../execution/mandate'
import { OperationalError } from '../errors'
import type {
  RecoveryFirstCycleAdvance,
  RecoveryFirstCycleDriver,
  RecoveryFirstCycleDriverOwner,
} from '../observe-composition'
import { currentUtcInstant } from '../time'
import { withObservedStage } from '../telemetry'
import { runRestateAdvanceWithinTimeout } from '../observe-composition/recovery-driver'

export const executionGenerationNeedsRecovery = (authority: AuthorityState): boolean =>
  authority.maximum === Authority.Execution &&
  authority.effective === Authority.Observe &&
  authority.kill === KillState.Active &&
  isExecutionMandateRecoveryRestriction(authority.reason)

export const withGenerationRebinding =
  (
    startCycle: AutonomousCycleStartup<never, never>,
    resolveNext: Effect.Effect<AutonomousRuntime<never, never>, OperationalError, Scope.Scope>,
  ): AutonomousCycleStartup<never, never> =>
  (startup) =>
    startCycle(startup).pipe(
      Effect.map((loop) =>
        loop.pipe(
          Effect.andThen(resolveNext),
          Effect.flatMap((next) => {
            if (next.cycleBindingId === undefined || next.cycleBindingId === null)
              return Effect.die(
                new OperationalError({
                  component: 'strategy',
                  operation: 'generation-rebind',
                  retryable: false,
                  message: 'recovered runtime has no cycle binding',
                }),
              )
            return next.startCycle({ ...startup, cycleBindingId: next.cycleBindingId })
          }),
          Effect.flatMap((nextLoop) => nextLoop),
          Effect.catch(Effect.die),
          Effect.scoped,
        ),
      ),
    )

interface GenerationCycleInput {
  readonly generationHash: string
  readonly mode: 'Mutation' | 'CloseOnly'
  readonly readAuthority: Effect.Effect<AuthorityState, OperationalError>
  readonly reconcileWhenHeld: Effect.Effect<void, OperationalError>
  readonly settle: Effect.Effect<TerminalGenerationRolloverReceipt, OperationalError>
}

export const makeGenerationCycleDriver = <R>(input: GenerationCycleInput, driver: RecoveryFirstCycleDriver<R>) =>
  Effect.gen(function* () {
    const rebind = yield* Deferred.make<void>()
    const permit = yield* Semaphore.make(1)
    const authorityReadBudgetMs = Math.max(1, Math.min(5_000, Math.floor(driver.timeoutMs / 6)))
    const readAuthority = input.readAuthority.pipe(
      Effect.timeoutOrElse({
        duration: authorityReadBudgetMs,
        orElse: () =>
          Effect.fail(
            new OperationalError({
              component: 'database',
              operation: 'read-authority',
              retryable: true,
              message: `Execution authority read exceeded its ${authorityReadBudgetMs}ms budget`,
            }),
          ),
      }),
      withObservedStage('bayn.execution.generation.read', { dependency: 'postgresql' }),
    )
    const disposition = (authority: AuthorityState): 'Continue' | 'Rebind' | 'Hold' => {
      if (authority.generationHash !== input.generationHash) return 'Rebind'
      if (executionGenerationNeedsRecovery(authority)) return input.mode === 'CloseOnly' ? 'Continue' : 'Rebind'
      if (
        authority.maximum === Authority.Execution &&
        authority.effective === Authority.Execution &&
        authority.kill === KillState.Clear
      )
        return input.mode === 'Mutation' ? 'Continue' : 'Rebind'
      return 'Hold'
    }
    const advance = Effect.gen(function* () {
      let cycleInProgress = false
      return yield* runRestateAdvanceWithinTimeout(
        permit,
        Effect.gen(function* () {
          const before = disposition(yield* readAuthority)
          if (before !== 'Continue') {
            if (before === 'Rebind') yield* Deferred.succeed(rebind, undefined)
            else yield* input.reconcileWhenHeld.pipe(withObservedStage('bayn.execution.generation.reconcile-held'))
            return {
              observation: {
                result: 'FAILURE',
                observedAt: yield* currentUtcInstant,
                operation: 'read-authority-slot',
                failure: 'context',
                message:
                  before === 'Rebind'
                    ? 'execution generation changed; preparing the current authority driver'
                    : 'execution generation remains restricted by operator or authority policy',
              },
            } satisfies RecoveryFirstCycleAdvance
          }
          cycleInProgress = true
          const advanced = yield* driver.advance
          cycleInProgress = false
          const after = disposition(yield* readAuthority)
          if (after === 'Rebind') yield* Deferred.succeed(rebind, undefined)
          if (after !== 'Continue' || input.mode !== 'CloseOnly') return advanced
          const recovery = yield* advanceRestrictedGenerationRecovery(
            Effect.succeed(advanced),
            input.settle.pipe(withObservedStage('bayn.execution.generation.settle')),
          )
          if (recovery._tag === 'RolledOver') {
            yield* Deferred.succeed(rebind, undefined)
            return advanced
          }
          const current = yield* readAuthority
          const step = recognizeRestrictedGenerationRebind(recovery, input.generationHash, current.generationHash)
          if (step._tag !== 'Waiting') yield* Deferred.succeed(rebind, undefined)
          return advanced
        }),
        driver.timeoutMs,
        (error) => (cycleInProgress ? driver.onTimeout(error) : Effect.fail(error)),
      )
    }).pipe(Effect.catch((cause) => (cause instanceof OperationalError ? Effect.die(cause) : Effect.fail(cause))))
    return {
      driver: { ...driver, advance },
      awaitRebind: Deferred.await(rebind),
      needsRebind: Deferred.isDone(rebind),
    }
  })

export const ownGenerationCycleDriver =
  <R>(
    input: GenerationCycleInput & { readonly owner: RecoveryFirstCycleDriverOwner<R> },
  ): RecoveryFirstCycleDriverOwner<R> =>
  (driver) =>
    makeGenerationCycleDriver(input, driver).pipe(
      Effect.flatMap((owned) =>
        Effect.raceFirst(input.owner(owned.driver).pipe(Effect.andThen(Effect.never)), owned.awaitRebind),
      ),
    )
