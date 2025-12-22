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
    'Implement this issue end to end.',
    `Repository: ${repositoryFullName}`,
    `Issue: #${issueNumber} - ${issueTitle}`,
    `Issue URL: ${issueUrl}`,
    `Base branch: ${baseBranch}`,
    `Implementation branch: ${headBranch}`,
    '',
    'Do:',
    '- Make the smallest set of changes needed; avoid unrelated refactors.',
    `- Work on \`${headBranch}\` (from \`${baseBranch}\`); commit in logical units referencing #${issueNumber} and push the branch.`,
    `- Keep the progress comment anchored by ${PROGRESS_COMMENT_MARKER} current; use apps/froussard/src/codex/cli/codex-progress-comment.ts for updates + final summary.`,
    '- Run required formatters/linters/tests; capture command output and fix failures before finishing.',
    `- Create/update a PR targeting \`${baseBranch}\`, fill .github/PULL_REQUEST_TEMPLATE.md, and link #${issueNumber}.`,
    '- If you need fresh context, use web.run and cite sources.',
    '- If blocked, state the blocker and the next concrete step.',
    '',
    'Memory capture:',
    '- For each meaningful code or config change, save a memory in Jangar via the CLI helper.',
    '- Use `bun run save-memory --task-name "<short>" --content "<what changed + why>" --summary "<1 line>" --tags "<comma,separated>"`.',
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
