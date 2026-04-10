import { resolveChatConfig, validateChatConfig } from './chat-config'
import { resolveMetricsConfig } from './metrics-config'
import type { JangarRuntimeProfile } from './runtime-profile'

export const validateRuntimeProfileConfiguration = (
  profile: JangarRuntimeProfile,
  env: Record<string, string | undefined> = process.env,
) => {
  const chatConfig = resolveChatConfig(env)
  resolveMetricsConfig(env)
  validateChatConfig(chatConfig, {
    enforceProductionRequirements: profile.name !== 'test' && chatConfig.isProduction,
  })
}
