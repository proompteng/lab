import { Effect } from 'effect'
import { createActor, createMachine } from 'xstate'

type PullRequestPolicyInput = {
  stage: string
  requirePullRequest: boolean
  prUrl: string | null
  swarmAgentRole?: string | null
  swarmHumanName?: string | null
  requireArchitectMergeEvidence?: boolean
  hasArchitectMergeEvidence?: boolean
}

type PullRequestPolicySatisfied = {
  ok: true
  enforced: boolean
}

type PullRequestPolicyViolation = {
  ok: false
  reason: 'MissingPullRequest' | 'MissingArchitectMergeEvidence'
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
          {
            guard: () => Boolean(input.requireArchitectMergeEvidence) && !Boolean(input.hasArchitectMergeEvidence),
            target: 'rejectedMissingArchitectMergeEvidence',
          },
          { guard: () => input.stage !== 'implementation', target: 'allowedNotEnforced' },
          { guard: () => isReleaseManagerRun(input), target: 'allowedNotEnforced' },
          { guard: () => !input.requirePullRequest, target: 'allowedNotEnforced' },
          { guard: () => Boolean(input.prUrl && input.prUrl.trim().length > 0), target: 'allowedEnforced' },
          { target: 'rejectedMissingPullRequest' },
        ],
      },
      allowedNotEnforced: { type: 'final' },
      allowedEnforced: { type: 'final' },
      rejectedMissingArchitectMergeEvidence: { type: 'final' },
      rejectedMissingPullRequest: { type: 'final' },
    },
  })

const normalizeRoleLabel = (value: string | null | undefined) =>
  (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')

const isReleaseManagerRun = (input: PullRequestPolicyInput) => {
  const role = normalizeRoleLabel(input.swarmAgentRole)
  const humanName = normalizeRoleLabel(input.swarmHumanName)
  return role === 'deployer' || role === 'release-manager' || humanName === 'release-manager'
}

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
    if (snapshot.matches('rejectedMissingArchitectMergeEvidence')) {
      return {
        ok: false,
        reason: 'MissingArchitectMergeEvidence',
        message: 'Architect run changed repository files but did not provide merged PR/commit evidence',
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
