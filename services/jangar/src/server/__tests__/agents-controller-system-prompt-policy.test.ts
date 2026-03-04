import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { evaluateSystemPromptPolicy } from '~/server/agents-controller/system-prompt-policy'

describe('system prompt policy machine', () => {
  it('rejects AgentRun-level overrides before evaluating defaults', () => {
    const decision = Effect.runSync(
      evaluateSystemPromptPolicy({
        hasRunOverride: true,
        hasDefaultRef: true,
        hasDefaultInline: true,
      }),
    )

    expect(decision).toEqual({
      ok: false,
      reason: 'SystemPromptOverrideNotAllowed',
      message:
        'AgentRun-level systemPrompt/systemPromptRef overrides are not allowed; configure Agent.spec.defaults instead',
    })
  })

  it('prioritizes default refs and keeps inline fallback when both are set', () => {
    const decision = Effect.runSync(
      evaluateSystemPromptPolicy({
        hasRunOverride: false,
        hasDefaultRef: true,
        hasDefaultInline: true,
      }),
    )

    expect(decision).toEqual({
      ok: true,
      candidateOrder: ['ref', 'inline'],
    })
  })

  it('uses inline defaults when refs are absent', () => {
    const decision = Effect.runSync(
      evaluateSystemPromptPolicy({
        hasRunOverride: false,
        hasDefaultRef: false,
        hasDefaultInline: true,
      }),
    )

    expect(decision).toEqual({
      ok: true,
      candidateOrder: ['inline'],
    })
  })

  it('fails when neither default source is configured', () => {
    const decision = Effect.runSync(
      evaluateSystemPromptPolicy({
        hasRunOverride: false,
        hasDefaultRef: false,
        hasDefaultInline: false,
      }),
    )

    expect(decision).toEqual({
      ok: false,
      reason: 'MissingSystemPromptConfiguration',
      message: 'Agent.spec.defaults.systemPrompt or Agent.spec.defaults.systemPromptRef is required',
    })
  })
})
