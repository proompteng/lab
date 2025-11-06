import { Effect, Option, Ref } from 'effect'

import type { ActivityContext } from '../worker/activity-context'
import type { WorkflowRetryPolicyInput } from '../workflow/determinism'

export interface HeartbeatState {
  readonly lastDetails: unknown[]
  readonly lastBeat: number
}

export interface ActivityRetryState {
  readonly attempt: number
  readonly nextDelayMs: number
}

export interface ActivityLifecycleConfig {
  readonly defaultHeartbeatIntervalMs: number
}

export interface ActivityLifecycle {
  readonly registerHeartbeat: (
    context: ActivityContext,
  ) => Effect.Effect<(details: unknown[]) => Effect.Effect<void, unknown, never>, unknown, never>
  readonly nextRetryDelay: (
    retry: WorkflowRetryPolicyInput | undefined,
    state: ActivityRetryState,
  ) => Effect.Effect<ActivityRetryState, never, never>
}

export const makeActivityLifecycle = (
  config: ActivityLifecycleConfig,
): Effect.Effect<ActivityLifecycle, never, never> =>
  Effect.gen(function* () {
    const heartbeatStores = yield* Ref.make(new WeakMap<ActivityContext, Ref.Ref<Option.Option<HeartbeatState>>>())

    const registerHeartbeat: ActivityLifecycle['registerHeartbeat'] = (context) =>
      Effect.gen(function* () {
        const stores = yield* Ref.get(heartbeatStores)
        let store = stores.get(context)
        if (!store) {
          store = yield* Ref.make<Option.Option<HeartbeatState>>(Option.none())
          stores.set(context, store)
          yield* Ref.set(heartbeatStores, stores)
        }

        return (details) =>
          store!
            .set(
              Option.some({
                lastDetails: details,
                lastBeat: Date.now(),
              }),
            )
            .pipe(
              Effect.zipRight(
                // TODO(TBS-002): Hook into WorkflowService RespondActivityTaskHeartbeat once available.
                Effect.sync(() => {
                  console.debug('[temporal-bun-sdk] heartbeat details captured', details)
                }),
              ),
            )
      })

    const nextRetryDelay: ActivityLifecycle['nextRetryDelay'] = (retry, state) =>
      Effect.sync(() => {
        // TODO(TBS-002): Honor Temporal retry policy (initial interval, backoff coefficient,
        // max interval, max attempts, non-retryable types). This is a placeholder.
        const base = retry?.initialIntervalMs ?? config.defaultHeartbeatIntervalMs
        return {
          attempt: state.attempt + 1,
          nextDelayMs: Math.min(base * Math.max(state.attempt, 1), retry?.maximumIntervalMs ?? base * 10),
        }
      })

    return {
      registerHeartbeat,
      nextRetryDelay,
    }
  })
