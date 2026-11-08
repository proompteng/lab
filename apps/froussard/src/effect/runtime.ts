import { Layer } from 'effect'
import { type ManagedRuntime, make as makeManagedRuntime } from 'effect/ManagedRuntime'

import { AppConfigLayer } from '@/effect/config'
import { AppLoggerLayer } from '@/logger'
import { GithubServiceLayer } from '@/services/github/service'
import { KafkaProducerLayer } from '@/services/kafka'
import { makeTelemetryLayer } from '@/telemetry'

const CoreAppLayer = Layer.mergeAll(AppConfigLayer, AppLoggerLayer)
const BaseAppLayer = Layer.mergeAll(
  CoreAppLayer,
  GithubServiceLayer,
  KafkaProducerLayer.pipe(Layer.provide(CoreAppLayer)),
)

export const AppLayer = BaseAppLayer

export type AppRuntime = ManagedRuntime<Layer.Success<typeof AppLayer>, Layer.Error<typeof AppLayer>>

export const makeAppRuntime = (): AppRuntime =>
  makeManagedRuntime(AppLayer.pipe(Layer.provideMerge(makeTelemetryLayer())))
