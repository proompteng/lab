import { Effect } from 'effect'

export type OpenAIConfig = {
  apiKey: null
  baseUrl: string
  models: string[]
  defaultModel: string
}

const DEFAULT_MODELS = ['gpt-5.3-codex', 'gpt-5.3-codex-spark']

const parseModelsEnv = (raw: string | undefined) => {
  if (!raw) return null
  const models = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  return models.length > 0 ? [...new Set(models)] : null
}

export const loadConfig = Effect.sync((): OpenAIConfig => {
  const models = parseModelsEnv(process.env.JANGAR_MODELS) ?? DEFAULT_MODELS
  const envDefault = process.env.JANGAR_DEFAULT_MODEL?.trim()
  const resolvedDefault = envDefault && envDefault.length > 0 ? envDefault : (models[0] ?? DEFAULT_MODELS[0])
  const normalizedModels = models.includes(resolvedDefault) ? models : [resolvedDefault, ...models]

  return {
    apiKey: null,
    baseUrl: 'https://api.openai.com/v1',
    models: normalizedModels,
    defaultModel: resolvedDefault,
  }
})
