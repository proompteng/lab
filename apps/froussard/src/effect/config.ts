import { Effect, Layer } from 'effect'

import { type AppConfig, loadConfig } from '@/config'

export type { AppConfig } from '@/config'

export class AppConfigService extends Effect.Tag('@froussard/AppConfig')<AppConfigService, AppConfig>() {}

export const AppConfigLayer = Layer.sync(AppConfigService, () => loadConfig())
