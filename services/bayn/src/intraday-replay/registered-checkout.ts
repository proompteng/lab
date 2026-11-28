import { fileURLToPath } from 'node:url'
import { Effect, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

import { SignalStudyFailure } from './signal-study'

export const verifyRegisteredCheckout = (sourceRevision: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    // Source and compiled research modules occupy the same depth below the checkout.
    const cwd = fileURLToPath(new URL('../../../../', import.meta.url))
    const git = (args: readonly string[]) =>
      Effect.gen(function* () {
        const child = yield* spawner.spawn(ChildProcess.make('git', args, { cwd, stdin: 'ignore', stderr: 'ignore' }))
        const [output, exitCode] = yield* Effect.all(
          [Stream.mkString(Stream.decodeText(child.stdout)), child.exitCode],
          { concurrency: 'unbounded' },
        )
        if (Number(exitCode) !== 0)
          return yield* new SignalStudyFailure({ message: 'Cannot verify the executing Git checkout' })
        return output.trim()
      }).pipe(
        Effect.scoped,
        Effect.timeout('10 seconds'),
        Effect.mapError(
          (cause) => new SignalStudyFailure({ message: 'Registered checkout verification failed', cause }),
        ),
      )
    if ((yield* git(['rev-parse', 'HEAD'])) !== sourceRevision)
      return yield* new SignalStudyFailure({ message: 'Executing checkout revision differs from registration' })
    if ((yield* git(['status', '--porcelain=v1', '--untracked-files=normal', '--ignore-submodules=none'])) !== '')
      return yield* new SignalStudyFailure({ message: 'Executing checkout must be clean and fully committed' })
  })
