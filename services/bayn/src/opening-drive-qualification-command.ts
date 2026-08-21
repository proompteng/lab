import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, Layer, Result, Stdio, Stream } from 'effect'

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

export type OpeningDriveQualificationCommand =
  | { readonly action: 'help' }
  | { readonly action: 'qualify'; readonly request: OpeningDriveQualificationRequest }

const commandError = (message: string): OpeningDriveQualificationProgramError =>
  new OpeningDriveQualificationProgramError({
    operation: 'request',
    message: `${message}; ${OPENING_DRIVE_QUALIFICATION_COMMAND_USAGE}`,
  })

export const parseOpeningDriveQualificationCommand = (
  args: readonly string[],
): Result.Result<OpeningDriveQualificationCommand, OpeningDriveQualificationProgramError> => {
  if (args.length === 1 && args[0] === '--help') return Result.succeed({ action: 'help' as const })
  if (args.length !== 4) return Result.fail(commandError('opening-drive qualification arguments are incomplete'))

  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if ((name !== '--start' && name !== '--end') || value === undefined || value.startsWith('--') || values.has(name)) {
      return Result.fail(commandError('opening-drive qualification arguments are malformed'))
    }
    values.set(name, value)
  }

  const start = values.get('--start')
  const end = values.get('--end')
  if (
    start === undefined ||
    end === undefined ||
    !/^\d{4}-\d{2}-\d{2}$/.test(start) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(end) ||
    start > end
  ) {
    return Result.fail(commandError('opening-drive qualification requires an ordered ISO session range'))
  }
  return Result.succeed({ action: 'qualify' as const, request: { start, end } })
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
const runtime = Layer.mergeAll(
  makeConfiguredTelemetryRuntimeLayer('bayn-opening-drive-qualification'),
  NodeServices.layer,
)
const program = Result.match(parseOpeningDriveQualificationCommand(args), {
  onFailure: (cause) => Effect.fail(cause),
  onSuccess: (command) =>
    (command.action === 'help' ? printUsage : run(command.request)).pipe(
      Effect.annotateLogs({ service: 'bayn-opening-drive-qualification' }),
      // @effect-diagnostics-next-line strictEffectProvide:off -- command entry point owns the runtime layer
      Effect.provide(runtime),
    ),
})

if (import.meta.main) NodeRuntime.runMain(program)
