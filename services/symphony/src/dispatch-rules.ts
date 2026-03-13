import type { Issue, SymphonyConfig } from './types'
import { normalizeState } from './utils'

type DispatchContext = {
  config: SymphonyConfig
  runningIssues: Issue[]
  claimedIssueIds: Set<string>
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

export const shouldDispatchIssue = (issue: Issue, context: DispatchContext): boolean => {
  if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false

  const activeStates = new Set(context.config.tracker.activeStates.map((state) => normalizeState(state)))
  const terminalStates = new Set(context.config.tracker.terminalStates.map((state) => normalizeState(state)))
  const normalizedState = normalizeState(issue.state)
  if (!activeStates.has(normalizedState) || terminalStates.has(normalizedState)) return false
  if (context.claimedIssueIds.has(issue.id)) return false
  if (context.runningIssues.some((runningIssue) => runningIssue.id === issue.id)) return false

  if (normalizedState === 'todo') {
    const hasActiveBlocker = issue.blockedBy.some((blocker) => !terminalStates.has(normalizeState(blocker.state)))
    if (hasActiveBlocker) return false
  }

  if (context.runningIssues.length >= context.config.agent.maxConcurrentAgents) return false

  const currentStateCount = context.runningIssues.filter(
    (runningIssue) => normalizeState(runningIssue.state) === normalizedState,
  ).length
  const stateLimit =
    context.config.agent.maxConcurrentAgentsByState[normalizedState] ?? context.config.agent.maxConcurrentAgents
  return currentStateCount < stateLimit
}
