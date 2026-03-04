import { Effect } from 'effect'
import { createActor, createMachine } from 'xstate'

type PullRequestPolicyInput = {
  stage: string
  requirePullRequest: boolean
  prUrl: string | null
}

type PullRequestPolicySatisfied = {
  ok: true
  enforced: boolean
}

type PullRequestPolicyViolation = {
  ok: false
  reason: 'MissingPullRequest'
  message: string
}

export type PullRequestPolicyDecision = PullRequestPolicySatisfied | PullRequestPolicyViolation

const createPullRequestPolicyMachine = (input: PullRequestPolicyInput) =>
  createMachine({
    id: 'codexImplementationPullRequestPolicy',
    initial: 'evaluate',
    states: {
      evaluate: {
        always: [
          { guard: () => input.stage !== 'implementation', target: 'allowedNotEnforced' },
          { guard: () => !input.requirePullRequest, target: 'allowedNotEnforced' },
          { guard: () => Boolean(input.prUrl && input.prUrl.trim().length > 0), target: 'allowedEnforced' },
          { target: 'rejectedMissingPullRequest' },
        ],
      },
      allowedNotEnforced: { type: 'final' },
      allowedEnforced: { type: 'final' },
      rejectedMissingPullRequest: { type: 'final' },
    },
  })

export const evaluatePullRequestPolicy = (input: PullRequestPolicyInput) =>
  Effect.sync<PullRequestPolicyDecision>(() => {
    const actor = createActor(createPullRequestPolicyMachine(input))
    actor.start()
    const snapshot = actor.getSnapshot()

    if (snapshot.matches('rejectedMissingPullRequest')) {
      return {
        ok: false,
        reason: 'MissingPullRequest',
        message: 'Implementation run completed without creating a pull request (missing PR_URL output)',
      }
    }

    if (snapshot.matches('allowedEnforced')) {
      return {
        ok: true,
        enforced: true,
      }
    }

    return {
      ok: true,
      enforced: false,
    }
  })
