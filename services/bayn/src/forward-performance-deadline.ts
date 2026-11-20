import { Data, Effect, FileSystem, Option, Sink, Stdio, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

export class ForwardPerformanceDeadlineExceeded extends Data.TaggedError('ForwardPerformanceDeadlineExceeded')<{
  readonly message: string
  readonly deadlineMs: number
}> {}

export class ForwardPerformanceWorkerFailed extends Data.TaggedError('ForwardPerformanceWorkerFailed')<{
  readonly message: string
  readonly exitCode: number
}> {}

/** Supervise read-only work independently of its event loop, retaining only complete successful stdout. */
export const runForwardPerformanceWithinDeadline = (executable: string, args: readonly string[], deadlineMs: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const stdio = yield* Stdio.Stdio
      const captured = yield* Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          fs.makeTempDirectory({ prefix: 'bayn-forward-performance-' }),
          (path) => fs.remove(path, { recursive: true, force: true }).pipe(Effect.orDie),
        )
        yield* fs.chmod(directory, 0o700)
        const file = yield* fs.open(`${directory}/stdout`, { flag: 'wx+', mode: 0o600 })
        yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawner.spawn(
              ChildProcess.make(executable, args, {
                stdin: 'ignore',
                stderr: 'inherit',
                killSignal: 'SIGTERM',
                forceKillAfter: '1 second',
              }),
            )
            const [, code] = yield* Effect.all(
              [
                Stream.run(
                  child.stdout,
                  Sink.forEach((chunk) => file.writeAll(chunk)),
                ),
                child.exitCode,
              ],
              { concurrency: 'unbounded' },
            )
            if (Number(code) !== 0)
              return yield* new ForwardPerformanceWorkerFailed({
                message: `forward-performance worker exited with code ${code}; captured stdout was discarded`,
                exitCode: Number(code),
              })
          }),
        )
        yield* file.seek(0n, 'start')
        // The Linux runtime can stream an open file after unlinking it. Keep the descriptor scoped
        // through publication, but finish worker cleanup and removal of named data within the budget.
        yield* fs.remove(directory, { recursive: true, force: true })
        return file
      }).pipe(
        Effect.timeoutOrElse({
          duration: deadlineMs,
          orElse: () =>
            Effect.fail(
              new ForwardPerformanceDeadlineExceeded({
                message: `forward-performance exceeded its ${deadlineMs}ms execution and capture deadline; captured stdout was discarded`,
                deadlineMs,
              }),
            ),
        }),
      )
      // Publication follows successful execution, capture and cleanup. It preserves bytes and
      // backpressure; an interrupted consumer can still truncate this final stdout transfer.
      yield* Stream.run(
        Stream.unfold(undefined, () =>
          captured.readAlloc(64 * 1024).pipe(
            Effect.map(
              Option.match({
                onNone: () => undefined,
                onSome: (chunk) => [chunk, undefined] as const,
              }),
            ),
          ),
        ),
        stdio.stdout(),
      )
    }),
  )
