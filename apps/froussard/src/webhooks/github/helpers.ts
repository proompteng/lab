export const toNumericId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return null
}

export const parseIssueNumberFromBranch = (branch: string, prefix: string): number | null => {
  if (typeof branch !== 'string' || branch.length === 0) {
    return null
  }
  const normalizedPrefix = prefix.toLowerCase()
  const normalizedBranch = branch.toLowerCase()
  if (normalizedBranch.startsWith(normalizedPrefix)) {
    const remainder = branch.slice(prefix.length)
    const match = remainder.match(/^(\d+)/)
    if (match) {
      const captured = match[1]
      if (captured) {
        const parsed = Number.parseInt(captured, 10)
        if (Number.isFinite(parsed)) {
          return parsed
        }
      }
    }
  }

  const fallbackMatch = branch.match(/(\d+)/)
  if (fallbackMatch) {
    const captured = fallbackMatch[1]
    if (captured) {
      const parsed = Number.parseInt(captured, 10)
      if (Number.isFinite(parsed)) {
        return parsed
      }
    }
  }

  return null
}

export const FORCE_REVIEW_ACTIONS = new Set(['opened', 'ready_for_review', 'reopened'])

const PR_ACTIONS = new Set([
  'opened',
  'ready_for_review',
  'synchronize',
  'reopened',
  'edited',
  'converted_to_draft',
  'review_requested',
  'review_request_removed',
])

export const shouldHandlePullRequestAction = (action?: string | null): boolean => {
  if (!action) {
    return false
  }
  return PR_ACTIONS.has(action)
}

const PR_REVIEW_ACTIONS = new Set(['submitted', 'edited', 'dismissed'])

export const shouldHandlePullRequestReviewAction = (action?: string | null): boolean => {
  if (!action) {
    return false
  }
  return PR_REVIEW_ACTIONS.has(action)
}
