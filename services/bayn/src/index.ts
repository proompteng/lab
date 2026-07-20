import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Cause, Effect, Layer, Logger } from 'effect'

import { run } from './app'
import { loadConfig } from './config'
import { makeRuntimeProvenance } from './contracts'
import { EvidenceStoreRuntimeLive } from './db/evidence-store'
import { JournalLive } from './ledger'
import { MarketDataLive } from './market-data'
import { hashTsmomParameters, loadDefaultProtocol } from './protocol'
import { makeTsmomStrategy, Strategy } from './strategy-service'

const main = Effect.gen(function* () {
  const config = yield* loadConfig()
  const protocol = yield* loadDefaultProtocol
  const provenance = makeRuntimeProvenance({
    sourceRevision: config.build.sourceRevision,
    image: {
      repository: config.build.imageRepository,
      digest: config.build.imageDigest,
    },
    strategy: {
      name: 'tsmom',
      behaviorHash: config.build.strategyBehaviorHash,
      parameterHash: hashTsmomParameters(protocol),
      parameterSchemaVersion: protocol.schemaVersion,
    },
  })
  const strategy = makeTsmomStrategy(protocol, provenance)
  const dependencies = Layer.mergeAll(
    MarketDataLive(config, strategy.universe),
    JournalLive(config),
    EvidenceStoreRuntimeLive(config).pipe(Layer.provide(NodeServices.layer)),
    Layer.succeed(Strategy, strategy),
  )
  return yield* run(config).pipe(Effect.provide(dependencies))
})

const program = main.pipe(
  Effect.tapCause((cause) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.void
      : Effect.logError('Bayn process failed').pipe(
          Effect.annotateLogs({ service: 'bayn', event: 'process_failed', cause: Cause.pretty(cause) }),
        ),
  ),
  Effect.provide(Logger.layer([Logger.consoleJson])),
)

NodeRuntime.runMain(program, { disableErrorReporting: true })
