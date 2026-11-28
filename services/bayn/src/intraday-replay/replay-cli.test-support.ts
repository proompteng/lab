import { expect } from 'bun:test'
import { Effect, FileSystem } from 'effect'

import type { EmbeddedBuildMetadata } from '../build'
import { config } from '../testing/runtime-fixtures'

export const writeCompiledReplayCommand = (
  path: string,
  entrypoint = `${import.meta.dir}/../backtest-command.ts`,
  build: EmbeddedBuildMetadata = config.build,
) =>
  Effect.gen(function* () {
    const compiled = yield* Effect.promise(() =>
      Bun.build({
        entrypoints: [entrypoint],
        target: 'node',
        external: ['tigerbeetle-node', '@platformatic/kafka'],
        define: {
          __BAYN_BUILD_SOURCE_REVISION__: JSON.stringify(build.sourceRevision),
          __BAYN_BUILD_IMAGE_REPOSITORY__: JSON.stringify(build.imageRepository),
          __BAYN_BUILD_STRATEGY_BEHAVIOR_HASH__: JSON.stringify(build.strategyBehaviorHash),
          __BAYN_BUILD_STRATEGY_PARAMETER_HASH__: JSON.stringify(build.strategyParameterHash),
        },
      }),
    )
    expect(compiled.success).toBe(true)
    const output = compiled.outputs[0]
    if (output === undefined || compiled.outputs.length !== 1) throw new Error('Missing compiled replay executable')
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFile(path, new Uint8Array(yield* Effect.promise(() => output.arrayBuffer())))
  })
