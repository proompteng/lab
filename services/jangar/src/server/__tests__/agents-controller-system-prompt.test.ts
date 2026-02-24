import { describe, expect, it, vi } from 'vitest'

import { parseSystemPromptRef, resolveSystemPrompt } from '~/server/agents-controller/system-prompt'
import { sha256Hex } from '~/server/agents-controller/template-hash'

describe('agents controller system-prompt module', () => {
  it('parses valid systemPromptRef objects', () => {
    expect(parseSystemPromptRef({ kind: 'secret', name: 'prompt-secret', key: 'prompt.txt' })).toEqual({
      ok: true,
      ref: {
        kind: 'Secret',
        name: 'prompt-secret',
        key: 'prompt.txt',
      },
    })
  })

  it('resolves inline system prompt from AgentRun spec', async () => {
    const kube = { get: vi.fn() }
    const result = await resolveSystemPrompt({
      kube,
      namespace: 'agents',
      agentRun: { spec: { systemPrompt: 'be concise' } },
      agent: null,
      runSecrets: [],
      allowedSecrets: [],
    })

    expect(result).toEqual({
      ok: true,
      systemPrompt: 'be concise',
      systemPromptRef: null,
      systemPromptHash: sha256Hex('be concise'),
    })
    expect(kube.get).not.toHaveBeenCalled()
  })

  it('falls back to agent defaults when AgentRun prompt fields are absent', async () => {
    const kube = { get: vi.fn() }
    const result = await resolveSystemPrompt({
      kube,
      namespace: 'agents',
      agentRun: { spec: {} },
      agent: { spec: { defaults: { systemPrompt: 'from-defaults' } } },
      runSecrets: [],
      allowedSecrets: [],
    })

    expect(result).toEqual({
      ok: true,
      systemPrompt: 'from-defaults',
      systemPromptRef: null,
      systemPromptHash: sha256Hex('from-defaults'),
    })
  })

  it('rejects inline prompts above maxInlineLength', async () => {
    const result = await resolveSystemPrompt({
      kube: { get: vi.fn() },
      namespace: 'agents',
      agentRun: { spec: { systemPrompt: '12345' } },
      agent: null,
      runSecrets: [],
      allowedSecrets: [],
      maxInlineLength: 4,
    })

    expect(result).toEqual({
      ok: false,
      reason: 'SystemPromptTooLong',
      message: 'systemPrompt exceeds 4 characters',
    })
  })

  it('rejects secret refs that are not in spec.secrets', async () => {
    const result = await resolveSystemPrompt({
      kube: { get: vi.fn() },
      namespace: 'agents',
      agentRun: { spec: { systemPromptRef: { kind: 'Secret', name: 'prompt-secret', key: 'prompt.txt' } } },
      agent: null,
      runSecrets: [],
      allowedSecrets: [],
    })

    expect(result).toEqual({
      ok: false,
      reason: 'SecretNotAllowed',
      message: 'system prompt secret prompt-secret is not included in spec.secrets',
    })
  })

  it('loads prompt content from referenced secret and returns hash', async () => {
    const kube = {
      get: vi.fn().mockResolvedValue({
        data: { 'prompt.txt': Buffer.from('from-secret').toString('base64') },
      }),
    }
    const result = await resolveSystemPrompt({
      kube,
      namespace: 'agents',
      agentRun: { spec: { systemPromptRef: { kind: 'Secret', name: 'prompt-secret', key: 'prompt.txt' } } },
      agent: null,
      runSecrets: ['prompt-secret'],
      allowedSecrets: ['prompt-secret'],
    })

    expect(kube.get).toHaveBeenCalledWith('secret', 'prompt-secret', 'agents')
    expect(result).toEqual({
      ok: true,
      systemPrompt: null,
      systemPromptRef: { kind: 'Secret', name: 'prompt-secret', key: 'prompt.txt' },
      systemPromptHash: sha256Hex('from-secret'),
    })
  })
})
