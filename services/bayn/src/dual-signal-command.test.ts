import { describe, expect, test } from 'bun:test'
import { Effect, FileSystem, Result, Stdio } from 'effect'

import { runDualSignalCommand } from './dual-signal-command'

describe('dual signal command output preflight', () => {
  test('refuses an occupied output before reading the request or constructing paid providers', async () => {
    const touched: string[] = []
    const fs = FileSystem.makeNoop({
      exists: (path) =>
        Effect.sync(() => {
          touched.push(`exists:${path}`)
          return true
        }),
      stat: () => Effect.die('request must not be inspected'),
      readFileString: () => Effect.die('request must not be read'),
      writeFileString: () => Effect.die('existing evidence must not be replaced'),
    })
    const outcome = await Effect.runPromise(
      runDualSignalCommand(['--request', 'input.json', '--output', 'existing.json']).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provide(Stdio.layerTest({})),
        Effect.result,
      ),
    )
    expect(Result.isFailure(outcome)).toBe(true)
    if (Result.isFailure(outcome))
      expect(outcome.failure).toMatchObject({
        _tag: 'DualSignalError',
        category: 'INPUT',
        message: 'Output path already exists',
      })
    expect(touched).toEqual(['exists:existing.json'])
  })

  test('an unoccupied output proceeds to input validation without writing a report', async () => {
    const touched: string[] = []
    const fallback = FileSystem.makeNoop({})
    const fs = FileSystem.makeNoop({
      exists: (path) =>
        Effect.sync(() => {
          touched.push(`exists:${path}`)
          return false
        }),
      stat: (path) =>
        Effect.sync(() => {
          touched.push(`stat:${path}`)
        }).pipe(Effect.andThen(fallback.stat(path))),
      writeFileString: () => Effect.die('invalid input must not create a report'),
    })
    const outcome = await Effect.runPromise(
      runDualSignalCommand(['--request', 'missing.json', '--output', 'new.json']).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provide(Stdio.layerTest({})),
        Effect.result,
      ),
    )
    expect(Result.isFailure(outcome)).toBe(true)
    expect(touched).toEqual(['exists:new.json', 'stat:missing.json'])
  })
})
