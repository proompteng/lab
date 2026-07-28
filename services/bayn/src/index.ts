import { NodeRuntime } from '@effect/platform-node'
import { Effect, Logger, pipe } from 'effect'

import { program } from './entrypoint'

NodeRuntime.runMain(
  pipe(program, Effect.annotateLogs({ service: 'bayn' }), Effect.provide(Logger.layer([Logger.consoleJson]))),
)
