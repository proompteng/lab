import process from 'node:process'

import { Deferred, Effect } from 'effect'

import { OrchestratorService } from './orchestrator'
import { createLogger } from './logger'
import { makeSymphonyRuntime } from './runtime'
import { SymphonyHttpServer } from './http-server'
import { toError } from './errors'

const parseArgs = (argv: string[]) => {
  let workflowPath = './WORKFLOW.md'
  let host: string | null = null
  let port: number | null = null

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--host') {
      const value = argv[index + 1]
      if (!value) {
        throw new Error('--host requires a value')
      }
      host = value
      index += 1
      continue
    }
    if (arg === '--port') {
      const value = argv[index + 1]
      if (!value) {
        throw new Error('--port requires a value')
      }
      port = Number.parseInt(value, 10)
      index += 1
      continue
    }
    workflowPath = arg
  }

  return { workflowPath, host, port }
}

const main = async () => {
  const logger = createLogger({ service: 'symphony' })
  const { workflowPath, host: cliHost, port: cliPort } = parseArgs(process.argv.slice(2))
  const runtime = makeSymphonyRuntime(workflowPath, logger)

  try {
    await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* OrchestratorService
          yield* orchestrator.start

          const workflowServer = yield* orchestrator.getCurrentConfig.pipe(Effect.map((config) => config.server))
          const hostToUse = cliHost ?? workflowServer.host
          const portToUse = cliPort ?? workflowServer.port

          let httpServer: SymphonyHttpServer<never, never> | null = null
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              httpServer?.stop()
            }),
          )

          if (portToUse !== null && Number.isFinite(portToUse)) {
            httpServer = new SymphonyHttpServer(runtime as never, logger)
            httpServer.start(portToUse, hostToUse)
          }

          const shutdownSignal = yield* Deferred.make<void, never>()
          const onSignal = () => {
            void runtime.runPromise(Deferred.succeed(shutdownSignal, undefined))
          }

          process.on('SIGINT', onSignal)
          process.on('SIGTERM', onSignal)

          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              process.off('SIGINT', onSignal)
              process.off('SIGTERM', onSignal)
            }),
          )

          yield* Deferred.await(shutdownSignal)
          yield* orchestrator.stop
        }),
      ),
    )
  } finally {
    await runtime.dispose()
  }
}

main().catch((error) => {
  const logger = createLogger({ service: 'symphony' })
  logger.log('error', 'startup_failed', { error: toError(error).message })
  process.exit(1)
})
