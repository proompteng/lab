import { Effect } from 'effect'

export type OpenAIConfig = {
  apiKey: null
  baseUrl: string
  models: string[]
  defaultModel: string
}

export type OpenWebUIRenderRuntime = {
  baseUrl: string
  secret: string
}

export type ChatConfig = OpenAIConfig & {
  isProduction: boolean
  isTest: boolean
  codexCwdOverride: string | null
  codexMaxInputChars: number
  statefulChatModeEnabled: boolean
  openWebUIRichRenderEnabled: boolean
  openWebUIExternalBaseUrl: string | null
  openWebUIRenderSigningSecret: string | null
}

type EnvSource = Record<string, string | undefined>

const DEFAULT_MODELS = ['gpt-5.4']
const DEFAULT_CODEX_MAX_INPUT_CHARS = 1_048_576

const parseModelsEnv = (raw: string | undefined) => {
  if (!raw) return null
  const models = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  return models.length > 0 ? [...new Set(models)] : null
}

const parseBooleanEnv = (value: string | undefined) => {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

const normalizeExternalBaseUrl = (value: string | undefined) => {
  const trimmed = value?.trim()
  return trimmed ? trimmed.replace(/\/+$/g, '') : null
}

const parsePositiveInteger = (name: string, value: string | undefined, fallback: number) => {
  const trimmed = value?.trim()
  if (!trimmed) return fallback
  const parsed = Number.parseInt(trimmed, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

const isTestEnvironment = (env: EnvSource) =>
  env.NODE_ENV === 'test' || Boolean(env.VITEST) || Boolean(env.VITEST_POOL_ID) || Boolean(env.VITEST_WORKER_ID)

export const resolveChatConfig = (env: EnvSource = process.env): ChatConfig => {
  const models = parseModelsEnv(env.JANGAR_MODELS) ?? DEFAULT_MODELS
  const envDefault = env.JANGAR_DEFAULT_MODEL?.trim()
  const resolvedDefault = envDefault && envDefault.length > 0 ? envDefault : (models[0] ?? DEFAULT_MODELS[0])
  const normalizedModels = models.includes(resolvedDefault) ? models : [resolvedDefault, ...models]

  return {
    apiKey: null,
    baseUrl: 'https://api.openai.com/v1',
    models: normalizedModels,
    defaultModel: resolvedDefault,
    isProduction: env.NODE_ENV === 'production',
    isTest: isTestEnvironment(env),
    codexCwdOverride: env.CODEX_CWD?.trim() || null,
    codexMaxInputChars: parsePositiveInteger(
      'JANGAR_CODEX_MAX_INPUT_CHARS',
      env.JANGAR_CODEX_MAX_INPUT_CHARS,
      DEFAULT_CODEX_MAX_INPUT_CHARS,
    ),
    statefulChatModeEnabled: (env.JANGAR_STATEFUL_CHAT_MODE ?? '').trim() !== '0',
    openWebUIRichRenderEnabled: parseBooleanEnv(env.JANGAR_OPENWEBUI_RICH_RENDER_ENABLED),
    openWebUIExternalBaseUrl: normalizeExternalBaseUrl(env.JANGAR_OPENWEBUI_EXTERNAL_BASE_URL),
    openWebUIRenderSigningSecret: env.JANGAR_OPENWEBUI_RENDER_SIGNING_SECRET?.trim() || null,
  }
}

export const resolveOpenWebUIRenderRuntime = (
  config: Pick<ChatConfig, 'openWebUIExternalBaseUrl' | 'openWebUIRenderSigningSecret'>,
): OpenWebUIRenderRuntime | null => {
  if (!config.openWebUIExternalBaseUrl || !config.openWebUIRenderSigningSecret) return null
  return {
    baseUrl: config.openWebUIExternalBaseUrl,
    secret: config.openWebUIRenderSigningSecret,
  }
}

export const validateChatConfig = (config: ChatConfig, options?: { enforceProductionRequirements?: boolean }) => {
  const enforceProductionRequirements = options?.enforceProductionRequirements ?? config.isProduction
  const errors: string[] = []

  if (enforceProductionRequirements && config.openWebUIRichRenderEnabled) {
    if (!config.openWebUIExternalBaseUrl) {
      errors.push('JANGAR_OPENWEBUI_EXTERNAL_BASE_URL is required when rich render mode is enabled in production')
    }
    if (!config.openWebUIRenderSigningSecret) {
      errors.push('JANGAR_OPENWEBUI_RENDER_SIGNING_SECRET is required when rich render mode is enabled in production')
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join('; '))
  }
}

export const loadChatConfig = Effect.sync(() => resolveChatConfig())

export const __private = {
  parseBooleanEnv,
  parseModelsEnv,
  normalizeExternalBaseUrl,
}
