import { randomUUID } from 'node:crypto'

export type Nullable<T> = T | null | undefined

export type CodexTaskStage = 'planning' | 'implementation' | 'review'

export const PLAN_COMMENT_MARKER = '<!-- codex:plan -->'
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

export interface ReviewThreadSummary {
  summary: string
  url?: string
  author?: string
}

export interface FailingCheckSummary {
  name: string
  conclusion?: string
  url?: string
  details?: string
}

export interface ReviewContext {
  summary?: string
  reviewThreads?: ReviewThreadSummary[]
  failingChecks?: FailingCheckSummary[]
  additionalNotes?: string[]
}

export interface BuildCodexPromptOptions {
  stage: CodexTaskStage
  issueTitle: string
  issueBody: string
  repositoryFullName: string
  issueNumber: number
  baseBranch: string
  headBranch: string
  issueUrl: string
  planCommentBody?: string
  reviewContext?: ReviewContext
}

const fallbackBody = 'No description provided.'

const buildPlanningPrompt = ({
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
    'Draft the plan the next Codex run will execute. Keep the instructions minimal and actionable.',
    `Repository: ${repositoryFullName}`,
    `Issue: #${issueNumber} – ${issueTitle}`,
    `Issue URL: ${issueUrl}`,
    `Base branch: ${baseBranch}`,
    `Proposed feature branch: ${headBranch}`,
    '',
    'Guidance:',
    '- Point to specific files, symbols, or docs the executor should inspect or change.',
    '- Call out validation commands or manual checks so the executor can verify results.',
    '- Use internet search (web.run) when the plan needs up-to-date facts.',
    `- Never emit raw \`cite…\` placeholders; link to GitHub code or docs instead (for example, \`[packages/foo.ts](https://github.com/${repositoryFullName}/blob/${baseBranch}/packages/foo.ts#L123)\`).`,
    '- Update or replace the `_Planning in progress…_` comment before posting the final plan.',
    '- Keep the plan short—surface only essential next actions Codex must take.',
    '',
    'Plan template (copy verbatim):',
    `${PLAN_COMMENT_MARKER}`,
    '### Summary',
    '### Steps',
    '### Validation',
    '### Risks',
    '### Handoff Notes',
    '',
    'Guidance: describe concrete files, commands, or checks; note why each step matters. Keep the plan short so the executor can scan it quickly.',
    '',
    'Issue context:',
    '"""',
    trimmedBody,
    '"""',
  ].join('\n')
}

const buildImplementationPrompt = ({
  issueTitle,
  issueBody,
  repositoryFullName,
  issueNumber,
  baseBranch,
  headBranch,
  issueUrl,
  planCommentBody,
}: BuildCodexPromptOptions): string => {
  const trimmedBody = issueBody.trim() || fallbackBody
  const sanitizedPlanBody = (planCommentBody ?? '').trim() || 'No approved plan content was provided.'

  return [
    'Execute the approved plan end to end. Keep notes concise and call out any deviations with their rationale.',
    `Repository: ${repositoryFullName}`,
    `Issue: #${issueNumber} – ${issueTitle}`,
    `Issue URL: ${issueUrl}`,
    `Base branch: ${baseBranch}`,
    `Implementation branch: ${headBranch}`,
    '',
    'Approved plan:',
    '"""',
    sanitizedPlanBody,
    '"""',
    '',
    'Guidance:',
    '- Follow the plan step by step; if you must adjust, note what changed and why.',
    `- Keep the progress comment anchored by ${PROGRESS_COMMENT_MARKER} up to date using apps/froussard/src/codex/cli/codex-progress-comment.ts.`,
    `- Work on \`${headBranch}\` (from \`${baseBranch}\`); keep commits tight and reference #${issueNumber}.`,
    '- Run formatters, lint, and focused tests; record command outputs in the progress comment.',
    `- Use internet search (web.run) when fresh context is needed, and cite with Markdown links back to docs or code (for example, \`[packages/foo.ts](https://github.com/${repositoryFullName}/blob/${headBranch}/packages/foo.ts#L123)\`).`,
    `- Open a draft PR targeting \`${baseBranch}\` with validation results and link it in the issue.`,
    '- After pushing the PR, wait 30 seconds, re-check CI; if checks are still running, wait another 30 seconds and poll until they pass; if any check fails, address it, push fixes, and continue the loop until everything is green.',
    '- Surface blockers quickly with mitigation ideas and capture manual QA needs.',
    '',
    'Issue body for quick reference:',
    '"""',
    trimmedBody,
    '"""',
  ].join('\n')
}

const buildReviewPrompt = ({
  issueTitle,
  repositoryFullName,
  issueNumber,
  baseBranch,
  headBranch,
  issueUrl,
  reviewContext,
}: BuildCodexPromptOptions): string => {
  const context = reviewContext ?? {}
  const summary = context.summary?.trim()
  const reviewThreads = context.reviewThreads ?? []
  const failingChecks = context.failingChecks ?? []
  const additionalNotes = context.additionalNotes ?? []

  const formatUrl = (value?: string) => (value && value.trim().length > 0 ? value.trim() : undefined)

  const reviewThreadLines = reviewThreads
    .map(({ summary: threadSummary, url, author }) => {
      const pieces = [threadSummary.trim()]
      if (author) {
        pieces.push(`(reviewer: ${author.trim()})`)
      }
      const formattedUrl = formatUrl(url)
      if (formattedUrl) {
        pieces.push(`→ ${formattedUrl}`)
      }
      return `- ${pieces.join(' ')}`
    })
    .filter((line) => line.trim().length > 2)

  const failingCheckLines = failingChecks
    .map(({ name, conclusion, url, details }) => {
      const pieces = [name.trim()]
      if (conclusion) {
        pieces.push(`status: ${conclusion.trim()}`)
      }
      if (details) {
        pieces.push(`notes: ${details.trim()}`)
      }
      const formattedUrl = formatUrl(url)
      if (formattedUrl) {
        pieces.push(`→ ${formattedUrl}`)
      }
      return `- ${pieces.join(' ')}`
    })
    .filter((line) => line.trim().length > 2)

  const additionalLines = additionalNotes
    .map((note) => note.trim())
    .filter((note) => note.length > 0)
    .map((note) => `- ${note}`)

  const contextSections: string[] = []
  if (summary) {
    contextSections.push(summary)
  }
  if (reviewThreadLines.length > 0) {
    contextSections.push(['Open review threads:', ...reviewThreadLines].join('\n'))
  }
  if (failingCheckLines.length > 0) {
    contextSections.push(['Failing checks:', ...failingCheckLines].join('\n'))
  }
  if (additionalLines.length > 0) {
    contextSections.push(['Additional notes:', ...additionalLines].join('\n'))
  }

  const contextBlock =
    contextSections.length > 0
      ? contextSections.join('\n\n')
      : [
          'No unresolved feedback or failing checks were supplied.',
          'Double-check the pull request status and exit once it is mergeable.',
        ].join('\n')

  return [
    'Address outstanding reviewer feedback and failing checks so the Codex-authored pull request becomes mergeable.',
    `Repository: ${repositoryFullName}`,
    `Issue: #${issueNumber} – ${issueTitle}`,
    `Issue URL: ${issueUrl}`,
    `Base branch: ${baseBranch}`,
    `Codex branch: ${headBranch}`,
    '',
    'Outstanding items from GitHub:',
    contextBlock,
    '',
    'Execution requirements:',
    `- Keep the progress comment anchored by ${PROGRESS_COMMENT_MARKER} up to date with current status and validation results.`,
    '- Keep the branch synced with the base branch and push commits after applying fixes.',
    '- Do not merge the pull request automatically; leave it ready for human review once mergeable.',
    '- Re-run or re-trigger failing checks until they pass or provide context if blocked.',
  ].join('\n')
}

export const buildCodexPrompt = (options: BuildCodexPromptOptions): string => {
  if (options.stage === 'planning') {
    return buildPlanningPrompt(options)
  }

  if (options.stage === 'implementation') {
    return buildImplementationPrompt(options)
  }

  if (options.stage === 'review') {
    return buildReviewPrompt(options)
  }

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
  reviewContext?: ReviewContext
}
