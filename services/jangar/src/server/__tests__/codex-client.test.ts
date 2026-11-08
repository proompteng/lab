import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { construct } = vi.hoisted(() => ({ construct: vi.fn() }))
vi.mock('@proompteng/codex', () => ({
  CodexAppServerClient: class {
    constructor(options: unknown) {
      construct(options)
    }
    stop() {}
  },
}))

import { getCodexClient, resetCodexClient } from '~/server/codex-client'
import { resolveCodexClientConfig } from '~/server/runtime-tooling-config'

const flamingoEnv = {
  JANGAR_FLAMINGO_MODEL: 'qwen38-flamingo',
  JANGAR_FLAMINGO_REASONING_EFFORT: 'xhigh',
  OPENAI_API_BASE_URL: 'http://flamingo.test/v1',
}

describe('Codex provider selection', () => {
  afterEach(() => {
    resetCodexClient()
    construct.mockClear()
    vi.unstubAllEnvs()
  })

  it('routes the configured Flamingo model to its Responses provider without OpenAI credentials', async () => {
    for (const [name, value] of Object.entries(flamingoEnv)) vi.stubEnv(name, value)
    await Effect.runPromise(getCodexClient({ defaultModel: 'qwen38-flamingo' }))
    expect(construct).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultModel: 'qwen38-flamingo',
        defaultEffort: 'xhigh',
        cliConfigOverrides: expect.arrayContaining([
          'model_provider="flamingo"',
          'model_providers.flamingo.base_url="http://flamingo.test/v1"',
          'model_providers.flamingo.wire_api="responses"',
          'model_providers.flamingo.requires_openai_auth=false',
          'model_reasoning_effort="xhigh"',
          'features.apps=false',
        ]),
        threadConfig: expect.objectContaining({
          model_provider: 'flamingo',
          web_search: 'disabled',
          mcp_servers: expect.objectContaining({ memories: expect.any(Object), atlas: expect.any(Object) }),
        }),
      }),
    )
  })

  it('keeps an explicitly selected Astra request on OpenAI', async () => {
    for (const [name, value] of Object.entries(flamingoEnv)) vi.stubEnv(name, value)
    await Effect.runPromise(getCodexClient({ defaultModel: 'gpt-6-astra' }))
    const options = construct.mock.calls[0]?.[0]
    expect(options).toMatchObject({ defaultModel: 'gpt-6-astra', threadConfig: { web_search: 'live' } })
    expect(options.cliConfigOverrides).not.toContain('model_provider="flamingo"')
    expect(options.cliConfigOverrides).not.toContain('features.apps=false')
    expect(options.defaultEffort).toBeUndefined()
  })

  it('rejects an incomplete Flamingo configuration before starting Codex', () => {
    expect(() => resolveCodexClientConfig({ JANGAR_FLAMINGO_MODEL: 'qwen38-flamingo' })).toThrow('OPENAI_API_BASE_URL')
    expect(() => resolveCodexClientConfig({ ...flamingoEnv, JANGAR_FLAMINGO_REASONING_EFFORT: 'high' })).toThrow(
      'JANGAR_FLAMINGO_REASONING_EFFORT',
    )
  })
})
