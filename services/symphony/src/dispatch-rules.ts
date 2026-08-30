import type { Issue, SymphonyConfig } from './types'
import { normalizeState } from './utils'

type DispatchContext = {
  config: SymphonyConfig
  runningIssues: Issue[]
  claimedIssueIds: Set<string>
}

export type DispatchDecision =
  | { eligible: true; reason: null }
  | {
      eligible: false
      reason:
        | 'missing_fields'
        | 'non_active_state'
        | 'claimed'
        | 'already_running'
        | 'manual_work_required'
        | 'blocked_issue'
        | 'no_slots'
        | 'state_slots_exhausted'
    }

export const sortIssuesForDispatch = (issues: Issue[]): Issue[] =>
  [...issues].sort((left, right) => {
    const leftPriority = left.priority ?? Number.MAX_SAFE_INTEGER
    const rightPriority = right.priority ?? Number.MAX_SAFE_INTEGER
    if (leftPriority !== rightPriority) return leftPriority - rightPriority
    const leftCreated = left.createdAt ? Date.parse(left.createdAt) : Number.MAX_SAFE_INTEGER
    const rightCreated = right.createdAt ? Date.parse(right.createdAt) : Number.MAX_SAFE_INTEGER
    if (leftCreated !== rightCreated) return leftCreated - rightCreated
    return left.identifier.localeCompare(right.identifier)
  })

export const evaluateDispatchIssue = (issue: Issue, context: DispatchContext): DispatchDecision => {
  if (!issue.id || !issue.identifier || !issue.title || !issue.state) {
    return { eligible: false, reason: 'missing_fields' }
  }

  const activeStates = new Set(context.config.tracker.activeStates.map((state) => normalizeState(state)))
  const terminalStates = new Set(context.config.tracker.terminalStates.map((state) => normalizeState(state)))
  const normalizedState = normalizeState(issue.state)
  if (!activeStates.has(normalizedState) || terminalStates.has(normalizedState)) {
    return { eligible: false, reason: 'non_active_state' }
  }
  if (context.claimedIssueIds.has(issue.id)) {
    return { eligible: false, reason: 'claimed' }
  }
  if (context.runningIssues.some((runningIssue) => runningIssue.id === issue.id)) {
    return { eligible: false, reason: 'already_running' }
  }

  const blockedLabels = new Set(context.config.release.blockedLabels.map((label) => normalizeState(label)))
  if (issue.labels.some((label) => blockedLabels.has(normalizeState(label)))) {
    return { eligible: false, reason: 'manual_work_required' }
  }

  if (normalizedState === 'todo') {
    const hasActiveBlocker = issue.blockedBy.some((blocker) => !terminalStates.has(normalizeState(blocker.state)))
    if (hasActiveBlocker) {
      return { eligible: false, reason: 'blocked_issue' }
    }
  }

  if (context.runningIssues.length >= context.config.agent.maxConcurrentAgents) {
    return { eligible: false, reason: 'no_slots' }
  }

  const currentStateCount = context.runningIssues.filter(
    (runningIssue) => normalizeState(runningIssue.state) === normalizedState,
  ).length
  const stateLimit =
    context.config.agent.maxConcurrentAgentsByState[normalizedState] ?? context.config.agent.maxConcurrentAgents
  if (currentStateCount >= stateLimit) {
    return { eligible: false, reason: 'state_slots_exhausted' }
  }

  return { eligible: true, reason: null }
}

export const shouldDispatchIssue = (issue: Issue, context: DispatchContext): boolean =>
  evaluateDispatchIssue(issue, context).eligible
