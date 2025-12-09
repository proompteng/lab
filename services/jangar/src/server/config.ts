import { Effect } from 'effect'

export type OpenAIConfig = {
  apiKey: null
  baseUrl: string
  models: string[]
  defaultModel: string
}

const staticConfig: OpenAIConfig = {
  apiKey: null,
  baseUrl: 'https://api.openai.com/v1',
  models: ['gpt-5.1-codex-max', 'gpt-5.1-codex', 'gpt-5.1-codex-mini', 'gpt-5.1'],
  defaultModel: 'gpt-5.1-codex-max',
}

export const loadConfig = Effect.succeed(staticConfig)
