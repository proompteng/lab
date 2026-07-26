import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, Layer, Logger, pipe } from 'effect'

import { program } from './entrypoint'

const runtime = Layer.merge(Logger.layer([Logger.consoleJson]), NodeServices.layer)

NodeRuntime.runMain(pipe(program, Effect.annotateLogs({ service: 'bayn' }), Effect.provide(runtime)))
