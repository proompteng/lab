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

  it('rejects AgentRun-level inline system prompt overrides', async () => {
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
      ok: false,
      reason: 'SystemPromptOverrideNotAllowed',
      message:
        'AgentRun-level systemPrompt/systemPromptRef overrides are not allowed; configure Agent.spec.defaults instead',
    })
    expect(kube.get).not.toHaveBeenCalled()
  })

  it('resolves inline system prompt from Agent defaults', async () => {
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
      resolvedSystemPrompt: 'from-defaults',
    })
  })

  it('rejects agent default inline prompts above maxInlineLength', async () => {
    const result = await resolveSystemPrompt({
      kube: { get: vi.fn() },
      namespace: 'agents',
      agentRun: { spec: {} },
      agent: { spec: { defaults: { systemPrompt: '12345' } } },
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

  it('rejects AgentRun-level secret ref system prompt overrides', async () => {
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
      reason: 'SystemPromptOverrideNotAllowed',
      message:
        'AgentRun-level systemPrompt/systemPromptRef overrides are not allowed; configure Agent.spec.defaults instead',
    })
  })

  it('loads prompt content from agent default secret ref and returns hash', async () => {
    const kube = {
      get: vi.fn().mockResolvedValue({
        data: { 'prompt.txt': Buffer.from('from-secret').toString('base64') },
      }),
    }
    const result = await resolveSystemPrompt({
      kube,
      namespace: 'agents',
      agentRun: { spec: {} },
      agent: { spec: { defaults: { systemPromptRef: { kind: 'Secret', name: 'prompt-secret', key: 'prompt.txt' } } } },
      runSecrets: ['prompt-secret'],
      allowedSecrets: ['prompt-secret'],
    })

    expect(kube.get).toHaveBeenCalledWith('secret', 'prompt-secret', 'agents')
    expect(result).toEqual({
      ok: true,
      systemPrompt: null,
      systemPromptRef: { kind: 'Secret', name: 'prompt-secret', key: 'prompt.txt' },
      systemPromptHash: sha256Hex('from-secret'),
      resolvedSystemPrompt: 'from-secret',
    })
  })

  it('fails when Agent defaults have no system prompt configured', async () => {
    const result = await resolveSystemPrompt({
      kube: { get: vi.fn() },
      namespace: 'agents',
      agentRun: { spec: {} },
      agent: { spec: {} },
      runSecrets: [],
      allowedSecrets: [],
    })

    expect(result).toEqual({
      ok: false,
      reason: 'MissingSystemPromptConfiguration',
      message: 'Agent.spec.defaults.systemPrompt or Agent.spec.defaults.systemPromptRef is required',
    })
  })
})
