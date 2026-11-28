import { Context, Layer } from 'effect'

import { type AppConfig, loadConfig } from '@/config'

export type { AppConfig } from '@/config'

export class AppConfigService extends Context.Service<AppConfigService, AppConfig>()('@froussard/AppConfig') {}

export const AppConfigLayer = Layer.sync(AppConfigService, () => loadConfig())
