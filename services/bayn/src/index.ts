import { NodeRuntime } from '@effect/platform-node'
import { Effect, Logger, pipe } from 'effect'

import { program } from './entrypoint'

NodeRuntime.runMain(
  // @effect-diagnostics-next-line strictEffectProvide:off -- process entry point owns the logger layer
  pipe(program, Effect.annotateLogs({ service: 'bayn' }), Effect.provide(Logger.layer([Logger.consoleJson]))),
)
