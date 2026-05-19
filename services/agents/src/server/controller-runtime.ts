import { Context, Data, Effect, Layer, ManagedRuntime } from 'effect'

import { getAgentsControllerHealth, startAgentsController, stopAgentsController } from './agents-controller'
import { createControllerStartupRetry } from './controller-startup-retry'
import {
  isLeaderElectionRequired,
  LeaderElection,
  LeaderElectionLive,
  type LeaderElectionService,
  stopLeaderElectionRuntime,
} from './leader-election'
import {
  getOrchestrationControllerHealth,
  startOrchestrationController,
  stopOrchestrationController,
} from './orchestration-controller'
import {
  getPrimitivesReconcilerHealth,
  startPrimitivesReconciler,
  stopPrimitivesReconciler,
} from './primitives-reconciler'
import {
  getSupportingControllerHealth,
  startSupportingPrimitivesController,
  stopSupportingPrimitivesController,
} from './supporting-primitives-controller'

export class AgentsControllerRuntimeError extends Data.TaggedError('AgentsControllerRuntimeError')<{
  readonly component: 'agents-controller' | 'leader-election' | 'primitives-reconciler' | 'supporting-controller'
  readonly operation: 'start' | 'stop'
  readonly cause: unknown
}> {}

export type AgentsControllerRuntimeService = {
  start: Effect.Effect<void, AgentsControllerRuntimeError>
  stop: Effect.Effect<void, never>
}

export class AgentsControllerRuntime extends Context.Tag('AgentsControllerRuntime')<
  AgentsControllerRuntime,
  AgentsControllerRuntimeService
>() {}

const agentsControllerStartup = createControllerStartupRetry({
  name: 'agents-controller',
  start: startAgentsController,
  isStarted: () => getAgentsControllerHealth().started,
  isEnabled: () => getAgentsControllerHealth().enabled,
  shouldRetry: (error) => !(error instanceof Error && error.name === 'NamespaceScopeConfigError'),
})

const orchestrationControllerStartup = createControllerStartupRetry({
  name: 'orchestration-controller',
  start: startOrchestrationController,
  isStarted: () => getOrchestrationControllerHealth().started,
  isEnabled: () => getOrchestrationControllerHealth().enabled,
  shouldRetry: (error) => !(error instanceof Error && error.name === 'NamespaceScopeConfigError'),
})

const primitivesReconcilerStartup = createControllerStartupRetry({
  name: 'primitives-reconciler',
  start: startPrimitivesReconciler,
  isStarted: () => getPrimitivesReconcilerHealth().started,
  isEnabled: () => getPrimitivesReconcilerHealth().enabled,
  shouldRetry: (error) => !(error instanceof Error && error.name === 'NamespaceScopeConfigError'),
})

const supportingControllerStartup = createControllerStartupRetry({
  name: 'supporting-controller',
  start: startSupportingPrimitivesController,
  isStarted: () => getSupportingControllerHealth().started,
  isEnabled: () => getSupportingControllerHealth().enabled,
  shouldRetry: (error) => !(error instanceof Error && error.name === 'NamespaceScopeConfigError'),
})

const startControllerRuntimes = () => {
  agentsControllerStartup.start()
  orchestrationControllerStartup.start()
  primitivesReconcilerStartup.start()
  supportingControllerStartup.start()
}

const stopControllerRuntimes = () => {
  agentsControllerStartup.cancel()
  orchestrationControllerStartup.cancel()
  primitivesReconcilerStartup.cancel()
  supportingControllerStartup.cancel()
  stopAgentsController()
  stopOrchestrationController()
  stopPrimitivesReconciler()
  stopSupportingPrimitivesController()
}

const startRuntime = (leaderElection: LeaderElectionService) =>
  Effect.gen(function* () {
    if (!isLeaderElectionRequired()) {
      startControllerRuntimes()
      return
    }

    yield* leaderElection
      .ensureRuntime({
        onLeader: startControllerRuntimes,
        onFollower: stopControllerRuntimes,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new AgentsControllerRuntimeError({
              component: 'leader-election',
              operation: 'start',
              cause,
            }),
        ),
      )
  })

const stopRuntime = Effect.sync(() => {
  stopControllerRuntimes()
  stopLeaderElectionRuntime()
})

export const createAgentsControllerRuntimeService = (
  leaderElection: LeaderElectionService,
): AgentsControllerRuntimeService => ({
  start: startRuntime(leaderElection),
  stop: stopRuntime,
})

export const AgentsControllerRuntimeLive = Layer.scoped(
  AgentsControllerRuntime,
  Effect.gen(function* () {
    const leaderElection = yield* LeaderElection
    const service = createAgentsControllerRuntimeService(leaderElection)
    yield* Effect.addFinalizer(() => service.stop)
    return service
  }),
)

export const AgentsControllerRuntimeLayer = AgentsControllerRuntimeLive.pipe(Layer.provide(LeaderElectionLive))

const controllerRuntime = ManagedRuntime.make(AgentsControllerRuntimeLayer)

export const startAgentsControllerRuntimeEffect = Effect.flatMap(AgentsControllerRuntime, (service) => service.start)

export const stopAgentsControllerRuntimeEffect = Effect.flatMap(AgentsControllerRuntime, (service) => service.stop)

export const runAgentsControllerRuntimeEffect = <A, E>(
  effect: Effect.Effect<A, E, AgentsControllerRuntime>,
): Promise<A> => controllerRuntime.runPromise(effect)

export const startAgentsControllerRuntime = async () => {
  await runAgentsControllerRuntimeEffect(startAgentsControllerRuntimeEffect)
}

export const stopAgentsControllerRuntime = () => {
  void runAgentsControllerRuntimeEffect(stopAgentsControllerRuntimeEffect)
}

export const __test__ = {
  startControllerRuntimes,
  stopControllerRuntimes,
}
