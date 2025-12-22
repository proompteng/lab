import { Layer } from 'effect'
import { type ManagedRuntime, make as makeManagedRuntime } from 'effect/ManagedRuntime'

import { AppConfigLayer } from '@/effect/config'
import { AppLoggerLayer } from '@/logger'
import { GithubServiceLayer } from '@/services/github/service'
import { KafkaProducerLayer } from '@/services/kafka'

const CoreAppLayer = Layer.mergeAll(AppConfigLayer, AppLoggerLayer)
const BaseAppLayer = Layer.mergeAll(
  CoreAppLayer,
  GithubServiceLayer,
  KafkaProducerLayer.pipe(Layer.provide(CoreAppLayer)),
)

export type AppRuntimeLayer = typeof BaseAppLayer

export const AppLayer = BaseAppLayer

export type AppRuntime = ManagedRuntime<Layer.Layer.Success<AppRuntimeLayer>, Layer.Layer.Error<AppRuntimeLayer>>

export const makeAppRuntime = (): AppRuntime => makeManagedRuntime(AppLayer)
