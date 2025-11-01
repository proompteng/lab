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
    'Draft the final plan the next Codex run will execute. This plan is posted verbatim as the GitHub planning comment and must eliminate ambiguity.',
    `Repository: ${repositoryFullName}`,
    `Issue: #${issueNumber} - ${issueTitle}`,
    `Issue URL: ${issueUrl}`,
    `Base branch: ${baseBranch}`,
    `Proposed feature branch: ${headBranch}`,
    '',
    'Execution contract:',
    '- Replace the `_Planning in progress…_` comment anchored by the plan marker with this finished plan.',
    '- Respond with only the Markdown template; do not add preambles, analysis, or TODO placeholders.',
    '- Reference repository paths, files, and symbols precisely so the executor knows exactly where to work.',
    '- Call out commands with working directories and expected outputs so validation is reproducible.',
    '- Highlight dependencies, migrations, approvals, or coordination steps so the executor can schedule work without guessing.',
    '- GitHub CLI (`gh`) is installed and authenticated; use it for issue comments or metadata as needed.',
    `- Use internet search (web.run) when fresh knowledge is required and cite links to GitHub code or docs (for example, \`[packages/foo.ts](https://github.com/${repositoryFullName}/blob/${baseBranch}/packages/foo.ts#L123)\`).`,
    `- Never emit raw \`cite…\` placeholders; format links normally.`,
    '- Keep tone concise but comprehensive so the next Codex run can finish the task end to end.',
    '',
    'Plan template (copy verbatim):',
    `${PLAN_COMMENT_MARKER}`,
    '### Objective',
    '### Context & Constraints',
    '### Task Breakdown',
    '### Deliverables',
    '### Validation & Observability',
    '### Risks & Contingencies',
    '### Communication & Handoff',
    '### Ready Checklist',
    '- [ ] Dependencies clarified (feature flags, secrets, linked services)',
    '- [ ] Test and validation environments are accessible',
    '- [ ] Required approvals/reviewers identified',
    '- [ ] Rollback or mitigation steps documented',
    '',
    'Guidance: describe concrete files, commands, or checks; explain why each step matters and how success is proven.',
    'Ensure validation aligns with the issue acceptance criteria and capture evidence the executor can record in the progress comment.',
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
    'Execute the approved plan end to end. Do not stop until the work is complete, validation passes, and a pull request referencing the issue is open.',
    `Repository: ${repositoryFullName}`,
    `Issue: #${issueNumber} - ${issueTitle}`,
    `Issue URL: ${issueUrl}`,
    `Base branch: ${baseBranch}`,
    `Implementation branch: ${headBranch}`,
    '',
    'Approved plan:',
    '"""',
    sanitizedPlanBody,
    '"""',
    '',
    'Execution contract:',
    '- Follow the approved plan step by step; document any deviations with rationale in the progress comment and handoff notes.',
    `- Keep the progress comment anchored by ${PROGRESS_COMMENT_MARKER} current with timestamps, commands, exit codes, links to logs, and validation evidence.`,
    '- Use apps/froussard/src/codex/cli/codex-progress-comment.ts for every progress update and the final summary.',
    `- Work on \`${headBranch}\` (from \`${baseBranch}\`); commit in logical units referencing #${issueNumber} and push the branch.`,
    '- GitHub CLI (`gh`) is installed and authenticated; use it to create or update pull requests and issue comments.',
    '- Run formatters, linters, and every validation command from the plan and acceptance criteria; capture outputs and resolve failures before moving on.',
    `- Use internet search (web.run) when fresh context is needed and cite GitHub links or docs in progress updates or code comments as appropriate.`,
    `- Open or update a draft pull request targeting \`${baseBranch}\`, populate .github/PULL_REQUEST_TEMPLATE.md completely, and link #${issueNumber}.`,
    '- Do not exit until the pull request exists, CI has passed or failing checks are documented with mitigation steps, and the progress comment contains the final status.',
    '- Surface blockers quickly with mitigation ideas, continuing autonomously unless a human decision is required.',
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
    'Drive the Codex-authored pull request to a merge-ready state by verifying every approved plan step, finishing any outstanding work, and recording an explicit verdict.',
    `Repository: ${repositoryFullName}`,
    `Issue: #${issueNumber} - ${issueTitle}`,
    `Issue URL: ${issueUrl}`,
    `Base branch: ${baseBranch}`,
    `Codex branch: ${headBranch}`,
    '',
    'Outstanding items from GitHub:',
    contextBlock,
    '',
    'Execution contract:',
    `- Keep the progress comment anchored by ${PROGRESS_COMMENT_MARKER} current with reviewer responses, validation reruns, commands, and timestamps.`,
    `- Fetch the latest approved plan anchored by ${PLAN_COMMENT_MARKER} on issue #${issueNumber}; treat each step as mandatory acceptance work.`,
    '- Summarise the pull request description, linked commits, and outstanding GitHub feedback before making changes.',
    '- For every plan step and acceptance criterion, gather proof from the code diff, tests, fixtures, or docs. If a gap remains, implement the missing work before re-checking.',
    '- Use apps/froussard/src/codex/cli/codex-progress-comment.ts to post review updates without manual formatting and to document validation evidence.',
    '- GitHub CLI (`gh`) is installed and authenticated; use it to fetch issue context, update the pull request, and interact with reviewers.',
    '- Re-run required tests, linters, and builds after each significant change; capture command output and attach it to the progress comment.',
    '- Keep the branch rebased with the base branch, resolve merge conflicts promptly, and ensure fingerprint dedupe continues to work after modifications.',
    '- If all plan steps and acceptance criteria are complete with passing validation, post an approval comment on the pull request summarizing the evidence (e.g., `gh pr comment --body "Plan complete; validation evidence: ..."`).',
    '- If blockers remain, leave a clear progress update describing what is missing and continue iterating until the pull request is genuinely merge-ready.',
    '- Always reason step by step, cite precise files or line numbers when giving feedback, and avoid speculation.',
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
