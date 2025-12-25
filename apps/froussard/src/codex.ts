import { randomUUID } from 'node:crypto'

export type Nullable<T> = T | null | undefined

export type CodexTaskStage = 'implementation'

export const PROGRESS_COMMENT_MARKER = '<!-- codex:progress -->'

export const normalizeLogin = (login?: Nullable<string>): string | null => {
  if (typeof login === 'string' && login.trim().length > 0) {
    return login.trim().toLowerCase()
  }
  return null
}

export const sanitizeBranchComponent = (value: string): string => {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'task'
  )
}

export const buildCodexBranchName = (issueNumber: number, deliveryId: string, branchPrefix: string): string => {
  const sanitizedPrefix = branchPrefix
  const suffix = sanitizeBranchComponent(deliveryId).slice(0, 8) || randomUUID().slice(0, 8)
  return `${sanitizedPrefix}${issueNumber}-${suffix}`
}

export interface BuildCodexPromptOptions {
  issueTitle: string
  issueBody: string
  repositoryFullName: string
  issueNumber: number
  baseBranch: string
  headBranch: string
  issueUrl: string
}

const fallbackBody = 'No description provided.'

const buildImplementationPrompt = ({
  issueTitle,
  issueBody,
  repositoryFullName,
  issueNumber,
  baseBranch,
  headBranch,
  issueUrl,
}: BuildCodexPromptOptions): string => {
  const trimmedBody = issueBody.trim() || fallbackBody

  return [
    'Implement this issue end to end and open a merge-ready PR.',
    `Repository: ${repositoryFullName}`,
    `Issue: #${issueNumber} - ${issueTitle}`,
    `Issue URL: ${issueUrl}`,
    `Base branch: ${baseBranch}`,
    `Head branch: ${headBranch}`,
    '',
    'Requirements:',
    '- Keep scope tight; smallest viable change set; avoid unrelated refactors.',
    `- Work only on \`${headBranch}\` based on \`${baseBranch}\`.`,
    '- Implement the requested changes.',
    `- Keep the progress comment anchored by ${PROGRESS_COMMENT_MARKER} current using`,
    '  apps/froussard/src/codex/cli/codex-progress-comment.ts.',
    '- Run all required formatters/linters/tests per repo instructions; fix and rerun until green.',
    `- Commit in logical units referencing #${issueNumber}; push the branch.`,
    '- Open the PR using the default template per repo instructions; link the issue.',
    '- Do not stop until the PR is opened and all required checks are green.',
    '- Use relevant repo skills in `skills/` when applicable; do not restate their instructions.',
    '',
    'Memory:',
    '- Retrieve relevant memories before and during work.',
    '- Save a memory for every change made.',
    '',
    'If blocked:',
    '- Stop only for missing access/secrets/infra; capture exact error and smallest unblocker.',
    '',
    'Final reply (concise):',
    '- Summary (2–4 bullets)',
    '- Tests (commands + pass/fail)',
    '- PR link',
    '- Blockers (if any)',
    '',
    'Issue body for quick reference:',
    '"""',
    trimmedBody,
    '"""',
  ].join('\n')
}

export const buildCodexPrompt = (options: BuildCodexPromptOptions): string => {
  return buildImplementationPrompt(options)
}

export interface CodexTaskMessage {
  stage: CodexTaskStage
  prompt: string
  repository: string
  base: string
  head: string
  issueNumber: number
  issueUrl: string
  issueTitle: string
  issueBody: string
  sender: string
  issuedAt: string
  planCommentId?: number
  planCommentUrl?: string
  planCommentBody?: string
}
