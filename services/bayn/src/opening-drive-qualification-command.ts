import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, Layer, Stdio, Stream } from 'effect'

import { loadConfig } from './config'
import { OpeningDriveQualificationResourcesLive } from './composition/resources'
import { canonicalJsonV1Result, renderCanonicalJsonFailure } from './hash'
import {
  OpeningDriveQualificationProgramError,
  runOpeningDriveQualification,
  type OpeningDriveQualificationRequest,
} from './strategy/opening-drive/qualification-program'
import { makeConfiguredTelemetryRuntimeLayer, withObservedSpan } from './telemetry'

export const OPENING_DRIVE_QUALIFICATION_COMMAND_USAGE =
  'Usage: bayn-opening-drive-qualification --start YYYY-MM-DD --end YYYY-MM-DD'

const parseRequest = (args: readonly string[]): OpeningDriveQualificationRequest | undefined => {
  const value = (name: string) => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : undefined
  }
  const start = value('--start')
  const end = value('--end')
  return start === undefined || end === undefined ? undefined : { start, end }
}

const printUsage = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  yield* Stream.run(Stream.make(`${OPENING_DRIVE_QUALIFICATION_COMMAND_USAGE}\n`), stdio.stdout())
})

const run = (request: OpeningDriveQualificationRequest) =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* loadConfig()
      const receipt = yield* runOpeningDriveQualification(config, request).pipe(
        // @effect-diagnostics-next-line strictEffectProvide:off -- command owns its scoped SQL resources
        Effect.provide(OpeningDriveQualificationResourcesLive(config)),
      )
      const output = yield* Effect.fromResult(canonicalJsonV1Result(receipt)).pipe(
        Effect.mapError(
          (cause) =>
            new OpeningDriveQualificationProgramError({
              operation: 'qualify',
              message: `opening-drive qualification output encoding failed: ${renderCanonicalJsonFailure(cause)}`,
              cause,
            }),
        ),
      )
      const stdio = yield* Stdio.Stdio
      yield* Stream.run(Stream.make(`${output}\n`), stdio.stdout())
    }),
  ).pipe(withObservedSpan('bayn.opening-drive.qualify'))

const args = process.argv.slice(2)
const request = parseRequest(args)
const main = args.includes('--help') || request === undefined ? printUsage : run(request)
const runtime = Layer.mergeAll(
  makeConfiguredTelemetryRuntimeLayer('bayn-opening-drive-qualification'),
  NodeServices.layer,
)
const program = main.pipe(
  Effect.annotateLogs({ service: 'bayn-opening-drive-qualification' }),
  // @effect-diagnostics-next-line strictEffectProvide:off -- command entry point owns the runtime layer
  Effect.provide(runtime),
)

if (import.meta.main) NodeRuntime.runMain(program)
