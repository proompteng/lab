import { fileURLToPath } from 'node:url'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Console, Effect, FileSystem, Layer, Logger, Redacted, Schema } from 'effect'
import { FetchHttpClient } from 'effect/http'

import { applyKnowledge } from './auto-ontology-api'
import { BaynKnowledge, strictKnowledge } from './auto-ontology-knowledge'
import { checkAnalysesOffline } from './auto-ontology-postgres'
import { OntologySyncError, parseMode, prepareKnowledge, SyncMode } from './sync-auto-ontology-core'

const seedPath = fileURLToPath(new URL('../../../docs/bayn/ontology/bayn-knowledge.json', import.meta.url))
const decodeSeed = Schema.decodeUnknownEffect(Schema.fromJsonString(BaynKnowledge), strictKnowledge)

export const syncAutoOntology = (args: readonly string[]) =>
  Effect.gen(function* () {
    const mode = yield* Effect.fromResult(parseMode(args))
    const fs = yield* FileSystem.FileSystem
    const seed = yield* fs.readFileString(seedPath).pipe(
      Effect.flatMap(decodeSeed),
      Effect.mapError(
        (cause) =>
          new OntologySyncError({
            operation: 'seed',
            message: 'Cannot read or decode docs/bayn/ontology/bayn-knowledge.json',
            cause: Redacted.make(cause),
          }),
      ),
    )
    const analyses = yield* Effect.fromResult(prepareKnowledge(seed))
    yield* checkAnalysesOffline(analyses)
    const writes = mode === SyncMode.Apply ? yield* applyKnowledge(seed) : 0
    return { mode, acronyms: seed.acronyms.length, rules: seed.rules.length, analyses: analyses.length, writes }
  })

if (import.meta.main) {
  const args = process.argv.slice(2)
  const runtime = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer, Logger.layer([Logger.consoleJson]))
  NodeRuntime.runMain(
    args.length === 1 && args[0] === '--help'
      ? Console.log('bun services/bayn/tools/sync-auto-ontology.ts [--mode dry-run|apply] (default: dry-run, no HTTP)')
      : syncAutoOntology(args).pipe(
          Effect.tap((summary) => Effect.logInfo('Bayn ontology sync complete', summary)),
          Effect.tapError(({ operation, status, message }) =>
            Effect.logError('Bayn ontology sync failed', { operation, status, message }),
          ),
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'error' }),
          // @effect-diagnostics-next-line strictEffectProvide:off -- composition root owns local preflight and HTTP
          Effect.provide(runtime),
        ),
  )
}
