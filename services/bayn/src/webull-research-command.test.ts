import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { Cause, Effect, Exit, FileSystem } from 'effect'

import { runWebullResearchCommand } from './webull-research-command'

test('Webull research help needs no credentials or network services', () =>
  Effect.runPromise(runWebullResearchCommand(['--help']).pipe(Effect.provide(NodeServices.layer))))

test('research command refuses to overwrite existing evidence before opening a client', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped()
        const input = `${root}/input.json`
        const output = `${root}/report.json`
        yield* fs.writeFileString(input, '{}')
        yield* fs.writeFileString(output, 'retained evidence')
        const exit = yield* Effect.exit(runWebullResearchCommand(['--input', input, '--output', output]))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain('Research output already exists')
        expect(yield* fs.readFileString(output)).toBe('retained evidence')
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  ))
