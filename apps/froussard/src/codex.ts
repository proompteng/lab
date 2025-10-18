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
    'Draft the plan the next Codex run will execute. Reply with the Markdown template below—no extra commentary.',
    `Repository: ${repositoryFullName}`,
    `Issue: #${issueNumber} – ${issueTitle}`,
    `Issue URL: ${issueUrl}`,
    `Base branch: ${baseBranch}`,
    `Proposed feature branch: ${headBranch}`,
    '',
    'Planning checklist:',
    '- React to the issue with :eyes: while drafting; switch to :rocket: once the final comment is posted.',
    '- Use internet search (web.run) to ground reasoning with fresh, cited sources before finalizing steps.',
    '- Post or update a `_Planning in progress…_` comment and replace it with the completed plan.',
    '- Focus on actionable steps the implementation run can carry out without interpretation.',
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
    'Execution requirements:',
    '- Follow the plan in order; if you must adjust, note what changed and why.',
    `- Maintain a single progress comment anchored by ${PROGRESS_COMMENT_MARKER} using apps/froussard/src/codex/cli/codex-progress-comment.ts (kickoff checklist, milestone updates, final summary).`,
    `- Work on \`${headBranch}\` (branched from \`${baseBranch}\`); keep commits focused and reference #${issueNumber}.`,
    '- Run formatters, lint, and tests; record their outputs or failures in the progress comment.',
    '- Ground decisions with internet search (web.run) to capture up-to-date facts and cite key findings.',
    `- Open a draft pull request targeting \`${baseBranch}\` with a summary, validation results, and "Closes #${issueNumber}".`,
    '- Comment on the issue with the PR link and any outstanding follow-ups.',
    '- Surface blockers promptly with mitigation ideas and capture required manual QA.',
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
