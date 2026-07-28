import { Effect, Result } from 'effect'

import { BrokerRead, type BrokerReadShape } from '../broker/alpaca'
import { BrokerMutation, type BrokerMutationShape } from '../broker/alpaca-mutations'
import type { LiveCapitalGrantStoreShape } from '../db/live-capital-grant'
import type { MutationOperation } from '../broker/alpaca-mutations'
import { cancel, dryRunSubmit, recover, submit } from './coordinator'
import { BrokerAccess, type ExecutionAuthority } from './authority'
import { IntentStore, type IntentStoreService } from './intents'
import { MutationStore, type MutationStoreShape } from './mutations'
import { makeAuthorityGuardedBrokerMutation } from './mutation-authority'
import { WriterFence, type WriterFenceService } from './writer-fence'

export interface ExecutionProgramDependencies {
  readonly brokerRead: BrokerReadShape
  readonly brokerMutation: BrokerMutationShape
  readonly intentStore: IntentStoreService
  readonly mutationStore: MutationStoreShape
  readonly writerFence: WriterFenceService
  readonly liveCapitalGrants: Pick<LiveCapitalGrantStoreShape, 'read'>
  readonly currentUtcInstant: Effect.Effect<string>
}

export interface ExecutionProgramConstructionFailure {
  readonly _tag: 'ExecutionProgramRequiresMutationAuthority'
  readonly brokerAccess: BrokerAccess
}

const provideCoordinatorDependencies = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  dependencies: ExecutionProgramDependencies,
) =>
  effect.pipe(
    Effect.provideService(BrokerRead, dependencies.brokerRead),
    Effect.provideService(BrokerMutation, dependencies.brokerMutation),
    Effect.provideService(IntentStore, dependencies.intentStore),
    Effect.provideService(MutationStore, dependencies.mutationStore),
    Effect.provideService(WriterFence, dependencies.writerFence),
  )

export const makeExecutionProgram = (authority: ExecutionAuthority, dependencies: ExecutionProgramDependencies) => {
  if (authority.brokerAccess !== BrokerAccess.Mutation) {
    return Result.fail({
      _tag: 'ExecutionProgramRequiresMutationAuthority' as const,
      brokerAccess: authority.brokerAccess,
    })
  }
  const coordinatorDependencies: ExecutionProgramDependencies = {
    ...dependencies,
    brokerMutation: makeAuthorityGuardedBrokerMutation(authority, dependencies),
  }
  return Result.succeed({
    _tag: 'ExecutionProgram' as const,
    schemaVersion: 'bayn.execution-program.v1' as const,
    authority,
    dryRunSubmit: (intentId: string) => provideCoordinatorDependencies(dryRunSubmit(intentId), coordinatorDependencies),
    submit: (intentId: string, consistencyDelayMs: number) =>
      provideCoordinatorDependencies(submit(intentId, consistencyDelayMs), coordinatorDependencies),
    cancel: (intentId: string, consistencyDelayMs: number) =>
      provideCoordinatorDependencies(cancel(intentId, consistencyDelayMs), coordinatorDependencies),
    recover: (intentId: string, operation: MutationOperation) =>
      provideCoordinatorDependencies(recover(intentId, operation), coordinatorDependencies),
  })
}

export type ExecutionProgram = Result.Result.Success<ReturnType<typeof makeExecutionProgram>>
