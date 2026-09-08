import { Effect } from 'effect'
import { createActor, createMachine } from 'xstate'

type SystemPromptPolicyInput = {
  hasRunOverride: boolean
  hasDefaultRef: boolean
  hasDefaultInline: boolean
}

type AllowedSystemPromptPolicy = {
  ok: true
  candidateOrder: Array<'ref' | 'inline'>
}

type RejectedSystemPromptPolicy = {
  ok: false
  reason: 'SystemPromptOverrideNotAllowed' | 'MissingSystemPromptConfiguration'
  message: string
}

export type SystemPromptPolicyDecision = AllowedSystemPromptPolicy | RejectedSystemPromptPolicy

const createSystemPromptPolicyMachine = (input: SystemPromptPolicyInput) =>
  createMachine({
    id: 'systemPromptPolicy',
    initial: 'evaluate',
    states: {
      evaluate: {
        always: [
          { guard: () => input.hasRunOverride, target: 'rejectedOverride' },
          { guard: () => input.hasDefaultRef, target: 'allowedRefFirst' },
          { guard: () => input.hasDefaultInline, target: 'allowedInlineOnly' },
          { target: 'rejectedMissing' },
        ],
      },
      allowedRefFirst: { type: 'final' },
      allowedInlineOnly: { type: 'final' },
      rejectedOverride: { type: 'final' },
      rejectedMissing: { type: 'final' },
    },
  })

export const evaluateSystemPromptPolicy = (input: SystemPromptPolicyInput) =>
  Effect.sync<SystemPromptPolicyDecision>(() => {
    const actor = createActor(createSystemPromptPolicyMachine(input))
    actor.start()
    const snapshot = actor.getSnapshot()

    if (snapshot.matches('rejectedOverride')) {
      return {
        ok: false,
        reason: 'SystemPromptOverrideNotAllowed',
        message:
          'AgentRun-level systemPrompt/systemPromptRef overrides are not allowed; configure Agent.spec.defaults instead',
      }
    }

    if (snapshot.matches('rejectedMissing')) {
      return {
        ok: false,
        reason: 'MissingSystemPromptConfiguration',
        message: 'Agent.spec.defaults.systemPrompt or Agent.spec.defaults.systemPromptRef is required',
      }
    }

    if (snapshot.matches('allowedRefFirst')) {
      const candidateOrder: Array<'ref' | 'inline'> = input.hasDefaultInline ? ['ref', 'inline'] : ['ref']
      return {
        ok: true,
        candidateOrder,
      }
    }

    return {
      ok: true,
      candidateOrder: ['inline'],
    }
  })
