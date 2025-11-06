import { Effect } from 'effect'

export interface TemporalDevServerConfig {
  readonly address: string
  readonly namespace: string
  readonly tls?: {
    readonly caPath?: string
    readonly certPath?: string
    readonly keyPath?: string
  }
}

export interface IntegrationHarness {
  readonly setup: Effect.Effect<void, unknown, never>
  readonly teardown: Effect.Effect<void, unknown, never>
  readonly runScenario: <A>(
    name: string,
    scenario: () => Effect.Effect<A, unknown, never>,
  ) => Effect.Effect<A, unknown, never>
}

export const createIntegrationHarness = (
  config: TemporalDevServerConfig,
): Effect.Effect<IntegrationHarness, unknown, never> =>
  Effect.gen(function* () {
    void config

    // TODO(TBS-006): Implement Temporal CLI orchestration, namespace seeding,
    // docker-compose lifecycle, and deterministic replay assertions.

    const setup = Effect.sync(() => {
      console.info('[temporal-bun-sdk] integration harness setup stub')
    })

    const teardown = Effect.sync(() => {
      console.info('[temporal-bun-sdk] integration harness teardown stub')
    })

    const runScenario: IntegrationHarness['runScenario'] = (name, scenario) =>
      Effect.sync(() => {
        console.info(`[temporal-bun-sdk] running scenario: ${name}`)
      }).pipe(Effect.zipRight(scenario()))

    return {
      setup,
      teardown,
      runScenario,
    }
  })
