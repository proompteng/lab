import { validateAgentctlGrpcConfig } from './agentctl-grpc-config'
import { validateAtlasRuntimeConfig } from './atlas-config'
import { resolveChatConfig, validateChatConfig } from './chat-config'
import { validateControlPlaneConfig } from './control-plane-config'
import { validateControllerRuntimeConfig } from './controller-runtime-config'
import { validateGithubReviewConfig } from './github-review-config'
import { validateIntegrationsConfig } from './integrations-config'
import { validateMemoryConfig } from './memory-config'
import { validateMigrationsConfig } from './migrations-config'
import { resolveMetricsConfig } from './metrics-config'
import { validateRuntimeEntryConfig } from './runtime-entry-config'
import { validateRuntimeToolingConfig } from './runtime-tooling-config'
import { validateAgentsControllerRuntimeConfig } from './agents-controller/runtime-config'
import { validateMarketContextConfig } from './torghut-market-context-config'
import { validateSupportingPrimitivesConfig } from './supporting-primitives-config'
import { validateStorageConfig } from './storage-config'
import { validateTerminalsConfig } from './terminals-config'
import { validateTorghutConfig } from './torghut-config'
import { validateWhitepaperConfig } from './whitepaper-config'
import type { JangarRuntimeProfile } from './runtime-profile'

export const validateRuntimeProfileConfiguration = (
  profile: JangarRuntimeProfile,
  env: Record<string, string | undefined> = process.env,
) => {
  const chatConfig = resolveChatConfig(env)
  resolveMetricsConfig(env)
  validateControllerRuntimeConfig(env)
  validateAgentsControllerRuntimeConfig(env)
  validateControlPlaneConfig(env)
  validateIntegrationsConfig(env)
  validateTorghutConfig(env)
  validateMarketContextConfig(env)
  validateWhitepaperConfig(env)
  validateAgentctlGrpcConfig(env)
  validateTerminalsConfig(env)
  validateSupportingPrimitivesConfig(env)
  validateRuntimeEntryConfig(env)
  validateRuntimeToolingConfig(env)
  validateAtlasRuntimeConfig(env)
  validateGithubReviewConfig(env)
  validateMigrationsConfig(env)
  validateChatConfig(chatConfig, {
    enforceProductionRequirements: profile.name !== 'test' && chatConfig.isProduction,
  })
  if (profile.name !== 'test' && chatConfig.isProduction) {
    validateStorageConfig(env, { enforceProductionDatabase: true })
    validateMemoryConfig(env, { requireApiKeyInProduction: false })
  }
}
