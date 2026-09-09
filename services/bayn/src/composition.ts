import { Effect, Layer } from 'effect'

import type { ApplicationPlan } from './app'
import { runReadOnlyAutonomousStatusService } from './composition/read-only-status'
import { AutonomousStatusApplicationResourcesLive } from './composition/resources'

const provideApplicationResources = <A, E, R, E2, RIn>(
  effect: Effect.Effect<A, E, R>,
  resources: Layer.Layer<R, E2, RIn>,
): Effect.Effect<A, E | E2, RIn> =>
  Effect.scoped(Layer.build(resources).pipe(Effect.flatMap((context) => Effect.provide(effect, context))))

export const runApplicationPlan = (plan: ApplicationPlan) =>
  provideApplicationResources(runReadOnlyAutonomousStatusService(plan), AutonomousStatusApplicationResourcesLive(plan))
