import { Effect } from 'effect'
import { join } from 'node:path'

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
    const packageRoot = join(import.meta.dir, '..', '..')
    const scriptsDir = join(packageRoot, 'scripts')
    const startScript = join(scriptsDir, 'start-temporal-cli.ts')
    const stopScript = join(scriptsDir, 'stop-temporal-cli.ts')

    const { hostname, port } = parseAddress(config.address)
    const uiPort = port + 1000

    const runScript = (scriptPath: string, overrides: Record<string, string>) =>
      Effect.tryPromise(async () => {
        const child = Bun.spawn([process.execPath, scriptPath], {
          cwd: packageRoot,
          stdout: 'inherit',
          stderr: 'inherit',
          env: { ...process.env, ...overrides },
        })
        const exitCode = await child.exited
        if (exitCode !== 0) {
          throw new Error(`Script ${scriptPath} exited with code ${exitCode}`)
        }
      })

    const setup = Effect.tap(
      runScript(startScript, {
        TEMPORAL_PORT: String(port),
        TEMPORAL_UI_PORT: String(uiPort),
        TEMPORAL_NAMESPACE: config.namespace,
      }),
      () =>
        Effect.sync(() => {
          console.info(`[temporal-bun-sdk] Temporal CLI dev server running at ${hostname}:${port}`)
        }),
    )

    const teardown = Effect.tap(
      runScript(stopScript, {}),
      () =>
        Effect.sync(() => {
          console.info('[temporal-bun-sdk] Temporal CLI dev server stopped')
        }),
    )

    const scenarioEnv: Record<string, string | undefined> = {
      TEMPORAL_ADDRESS: config.address,
      TEMPORAL_NAMESPACE: config.namespace,
      TEMPORAL_TLS_CA_PATH: config.tls?.caPath,
      TEMPORAL_TLS_CERT_PATH: config.tls?.certPath,
      TEMPORAL_TLS_KEY_PATH: config.tls?.keyPath,
    }

    const runScenario: IntegrationHarness['runScenario'] = (name, scenario) =>
      withEnvironment(
        scenarioEnv,
        Effect.sync(() => {
          console.info(`[temporal-bun-sdk] running integration scenario: ${name}`)
        }).pipe(Effect.zipRight(scenario())),
      )

    return {
      setup,
      teardown,
      runScenario,
    }
  })

const parseAddress = (value: string): { hostname: string; port: number } => {
  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`)
    const port = Number(url.port)
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`address is missing a valid port: ${value}`)
    }
    return { hostname: url.hostname, port }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid Temporal address "${value}": ${message}`)
  }
}

const withEnvironment = <A, E, R>(
  assignments: Record<string, string | undefined>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const snapshot = new Map<string, string | undefined>()
      for (const [key, value] of Object.entries(assignments)) {
        snapshot.set(key, process.env[key])
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
      return snapshot
    }),
    () => effect,
    (snapshot) =>
      Effect.sync(() => {
        for (const [key, value] of snapshot) {
          if (value === undefined) {
            delete process.env[key]
          } else {
            process.env[key] = value
          }
        }
      }),
  )
