import { randomUUID } from 'node:crypto'

export type Nullable<T> = T | null | undefined

export type CodexTaskStage = 'implementation'

export type CodexIterationsMode = 'fixed' | 'until' | 'budget' | 'adaptive'

export interface CodexIterationsPolicy {
  mode: CodexIterationsMode
  count?: number
  min?: number
  max?: number
  stopOn?: string[]
  reason?: string
}

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
    'Implement this issue end to end and open a ready-to-merge PR.',
    `Repository: ${repositoryFullName}`,
    `Issue: #${issueNumber} - ${issueTitle}`,
    `Issue URL: ${issueUrl}`,
    `Base branch: ${baseBranch}`,
    `Head branch: ${headBranch}`,
    '',
    'Requirements:',
    `- Work only on \`${headBranch}\` based on \`${baseBranch}\`.`,
    '- Implement the requested changes.',
    '- Do not stop until all issue requirements are fully satisfied and the changes meet production-quality standards.',
    `- Keep the progress comment anchored by ${PROGRESS_COMMENT_MARKER} current using`,
    '  apps/froussard/src/codex/cli/codex-progress-comment.ts.',
    '- Run all required formatters/linters/tests per repo instructions; fix and rerun until green.',
    '- To emit workflow updates, use `/usr/local/bin/codex-nats-publish` (see examples below).',
    `- Commit in logical units referencing #${issueNumber}; push the branch.`,
    '- Open a ready-to-merge PR using the default template per repo instructions; link the issue.',
    '- Finish only when required CI is green; fix failures and re-run the smallest necessary checks until it is.',
    '- Do not stop until the PR is opened and in a mergeable state; resolve merge conflicts, address all review comments from anyone, and keep CI checks green.',
    '- Use relevant repo skills in `skills/` when applicable; do not restate their instructions.',
    '',
    'Memory:',
    '- Retrieve relevant memories before and during work.',
    '- Save a memory for every change made.',
    '',
    'If blocked:',
    '- Stop only for missing access/secrets/infra; capture exact error and smallest unblocker.',
    '',
    'Publishing examples:',
    '- Status update (also to general):',
    '  /usr/local/bin/codex-nats-publish --kind status --status started --content "work started" --publish-general',
    '- Tail a log file:',
    '  /usr/local/bin/codex-nats-publish --kind log --log-file "$AGENT_LOG_PATH"',
    '',
    'Final reply (concise):',
    '- Summary (2–4 bullets)',
    '- Tests (commands + pass/fail)',
    '- PR markdown link',
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
  metadataVersion?: number
  iterations?: CodexIterationsPolicy
  iteration?: number
  iterationCycle?: number
}
