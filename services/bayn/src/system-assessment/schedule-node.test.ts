import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { Effect, FileSystem } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

test('Node retains every one-second reconciliation obligation across twenty full sessions', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const directory = yield* fs.makeTempDirectoryScoped()
      const built = yield* Effect.tryPromise(() =>
        Bun.build({
          entrypoints: [`${import.meta.dir}/schedule-node.test-support.ts`],
          target: 'node',
          outdir: directory,
          naming: 'schedule.mjs',
        }),
      )
      expect(built.success).toBe(true)
      const exitCode = yield* spawner.exitCode(
        ChildProcess.make('node', [`${directory}/schedule.mjs`], {
          stdin: 'ignore',
          stdout: 'inherit',
          stderr: 'inherit',
        }),
      )
      expect(Number(exitCode)).toBe(0)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
}, 60000)
