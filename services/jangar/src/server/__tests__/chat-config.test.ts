import { describe, expect, it } from 'vitest'

import { resolveChatConfig, resolveOpenWebUIRenderRuntime, validateChatConfig } from '~/server/chat-config'

describe('chat-config', () => {
  it('normalizes model config and preserves the configured default model', () => {
    const config = resolveChatConfig({
      JANGAR_MODELS: 'alpha, beta',
      JANGAR_DEFAULT_MODEL: 'gamma',
    })

    expect(config.defaultModel).toBe('gamma')
    expect(config.models).toEqual(['gamma', 'alpha', 'beta'])
  })

  it('parses rich render runtime settings', () => {
    const config = resolveChatConfig({
      JANGAR_OPENWEBUI_RICH_RENDER_ENABLED: 'true',
      JANGAR_OPENWEBUI_EXTERNAL_BASE_URL: 'https://jangar.example.com///',
      JANGAR_OPENWEBUI_RENDER_SIGNING_SECRET: 'secret-value',
    })

    expect(resolveOpenWebUIRenderRuntime(config)).toEqual({
      baseUrl: 'https://jangar.example.com',
      secret: 'secret-value',
    })
  })

  it('rejects invalid codex input limits', () => {
    expect(() =>
      resolveChatConfig({
        JANGAR_CODEX_MAX_INPUT_CHARS: '0',
      }),
    ).toThrow('JANGAR_CODEX_MAX_INPUT_CHARS must be a positive integer')
  })

  it('fails production validation when rich render mode is enabled without its required settings', () => {
    const config = resolveChatConfig({
      NODE_ENV: 'production',
      JANGAR_OPENWEBUI_RICH_RENDER_ENABLED: 'true',
    })

    expect(() => validateChatConfig(config)).toThrow(
      'JANGAR_OPENWEBUI_EXTERNAL_BASE_URL is required when rich render mode is enabled in production',
    )
  })
})
