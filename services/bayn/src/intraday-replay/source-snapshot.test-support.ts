import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Schema } from 'effect'
import { Sha256Schema } from '../schemas'
import { openBacktestSource, validateBacktestSourceReceipt } from './source'

NodeRuntime.runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const input = yield* fs
      .readFileString('/evidence/source.json')
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.fromJsonString(Schema.Struct({ manifest: Schema.Unknown, runId: Sha256Schema })),
          ),
        ),
      )
    const receipt = yield* Effect.fromResult(
      validateBacktestSourceReceipt(yield* fs.readFileString('/evidence/receipt.json'), process.argv[2]),
    )
    const source = yield* openBacktestSource('/evidence/arrivals.ndjson.gz', input.manifest, input.runId, receipt)
    yield* source.advanceTo(source.manifest.lastAvailableAtMs)
    yield* source.finish
    yield* fs.writeFileString(
      '/result/source-opened.json',
      JSON.stringify({
        processedRecords: (yield* source.cursor).processedRecords,
        sourceManifestHash: source.source.sourceManifestHash,
      }),
    )
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)
