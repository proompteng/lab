import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

import { NodeRuntime } from '@effect/platform-node'
import { Cause, Console, Data, Effect, Logger, Option, Redacted, Schema } from 'effect'

import { Sha256Schema, strictParseOptions, StrictNonEmptyStringSchema } from '../src/schemas'
import { decodeArchiveJson, withS3Archive } from './research-lib/s3-archive'
import {
  decodePortfolioEvidence,
  decodePortfolioScenario,
  defaultScenario,
  simulatePortfolio,
} from './simulate-multi-sleeve-portfolio-core'

const usage = `Usage: bun services/bayn/tools/simulate-multi-sleeve-portfolio.ts \
  (--fixture FILE | --archive OBJECT_KEY) --sha256 PINNED_SHA256 [--scenario FILE] [--daily]`

const cliSchema = Schema.Struct({
  fixture: Schema.optionalKey(StrictNonEmptyStringSchema),
  archive: Schema.optionalKey(StrictNonEmptyStringSchema),
  sha256: Schema.optionalKey(Sha256Schema),
  scenario: Schema.optionalKey(StrictNonEmptyStringSchema),
  daily: Schema.optionalKey(Schema.Boolean),
  help: Schema.optionalKey(Schema.Boolean),
})
const decodeArgs = Schema.decodeUnknownResult(cliSchema, strictParseOptions)

class PortfolioCommandError extends Data.TaggedError('PortfolioCommandError')<{
  readonly message: string
  readonly cause?: Redacted.Redacted<unknown>
}> {}

const commandError = (message: string, cause: unknown) =>
  new PortfolioCommandError({ message, cause: Redacted.make(cause) })

const read = (path: string, label: string) =>
  Effect.tryPromise({
    try: (signal) => readFile(path, { signal }),
    catch: (cause) => commandError(`Unable to read ${label} file`, cause),
  })

const readFixture = (path: string, digest: string) =>
  read(path, 'fixture').pipe(
    Effect.flatMap((bytes) =>
      Effect.try({
        try: () => decodeArchiveJson(bytes, 'fixture', digest),
        catch: (cause) => commandError('Fixture SHA-256 mismatch or invalid JSON', cause),
      }),
    ),
  )

export const runPortfolioCommand = (args: readonly string[], request?: Parameters<typeof withS3Archive>[1]) =>
  Effect.gen(function* () {
    const { tokens, values } = yield* Effect.try({
      try: () =>
        parseArgs({
          args,
          strict: true,
          allowPositionals: false,
          tokens: true,
          options: {
            fixture: { type: 'string' },
            archive: { type: 'string' },
            sha256: { type: 'string' },
            scenario: { type: 'string' },
            daily: { type: 'boolean' },
            help: { type: 'boolean' },
          },
        }),
      catch: (cause) => commandError(`Invalid arguments. ${usage}`, cause),
    })
    const seen = new Set<string>()
    for (const token of tokens) {
      if (token.kind !== 'option' || seen.has(token.name))
        return yield* new PortfolioCommandError({ message: `Unexpected or repeated option. ${usage}` })
      seen.add(token.name)
    }
    const options = yield* Effect.fromResult(decodeArgs(values)).pipe(
      Effect.mapError((cause) => commandError(`Invalid option value. ${usage}`, cause)),
    )
    if (options.help === true && seen.size === 1) return usage
    const { fixture, archive, sha256: digest } = options
    if (options.help === true || digest === undefined || (fixture !== undefined && archive !== undefined))
      return yield* new PortfolioCommandError({ message: usage })
    const source =
      fixture !== undefined
        ? readFixture(fixture, digest)
        : archive !== undefined
          ? withS3Archive((reader) => reader.readJson(archive, digest), request).pipe(
              Effect.timeout('30 seconds'),
              Effect.mapError((cause) =>
                commandError('Unable to verify archive JSON; check the object key, access and pinned SHA-256', cause),
              ),
            )
          : new PortfolioCommandError({ message: usage })

    let scenario = defaultScenario
    if (options.scenario !== undefined) {
      const bytes = yield* read(options.scenario, 'scenario')
      const input = yield* Effect.try({
        try: (): unknown => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        catch: (cause) => commandError('Invalid scenario JSON', cause),
      })
      scenario = yield* Effect.fromResult(decodePortfolioScenario(input))
    }

    const input = yield* source
    const evidence = yield* Effect.fromResult(decodePortfolioEvidence(input))
    const { runs, ...report } = yield* Effect.fromResult(simulatePortfolio(evidence, scenario))
    return JSON.stringify(
      {
        ...report,
        evidenceSha256: digest,
        runs: options.daily === true ? runs : runs.map(({ daily: _daily, ...summary }) => summary),
      },
      null,
      2,
    )
  })

if (import.meta.main) {
  NodeRuntime.runMain(
    runPortfolioCommand(process.argv.slice(2)).pipe(
      Effect.flatMap(Console.log),
      Effect.tapCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.void
        const failure = Cause.findErrorOption(cause)
        return Effect.logError(Option.isSome(failure) ? failure.value : { kind: 'UnexpectedDefect' })
      }),
      // @effect-diagnostics-next-line strictEffectProvide:off -- the entry point owns CLI logging
      Effect.provide(Logger.layer([Logger.withConsoleError(Logger.formatJson)])),
    ),
    { disableErrorReporting: true },
  )
}
