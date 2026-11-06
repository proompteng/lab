import { Schema } from 'effect'

import { buildCodexBranchName, buildCodexPrompt, type GithubIssueAgentRunRequest, normalizeLogin } from '@/codex'
import { parseCodexIssueMetadata } from '@/codex/issue-metadata'
import type { ImplementationCommand } from '@/codex/workflow-machine'
import { selectReactionRepository } from '@/codex-workflow'
import { deriveRepositoryFullName, isGithubIssueCommentEvent, isGithubIssueEvent } from '@/github-payload'
import { logger } from '@/logger'
import { buildGithubIssueAgentRunPayload } from '@/services/agents'
import type { WebhookConfig } from '../../types'
import type { WorkflowExecutionContext, WorkflowStage } from '../workflow'
import { executeWorkflowCommands } from '../workflow'

export interface BaseIssueParams {
  parsedPayload: unknown
  headers: Record<string, string>
  config: WebhookConfig
  executionContext: WorkflowExecutionContext
  deliveryId: string
  senderLogin?: string
}

const SenderSchema = Schema.optional(
  Schema.NullOr(
    Schema.Struct({
      login: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
)

const RepositoryValueSchema = Schema.Struct({
  full_name: Schema.optional(Schema.NullOr(Schema.String)),
  default_branch: Schema.optional(Schema.NullOr(Schema.String)),
})

const RepositorySchema = Schema.optional(Schema.NullOr(RepositoryValueSchema))

const IssueSchema = Schema.Struct({
  number: Schema.Number,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
  repository_url: Schema.optional(Schema.NullOr(Schema.String)),
  repository: Schema.optional(Schema.NullOr(RepositoryValueSchema)),
  labels: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          name: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  ),
  pull_request: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        url: Schema.optional(Schema.NullOr(Schema.String)),
        html_url: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  user: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        login: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
})

const IssueOpenedPayloadSchema = Schema.Struct({
  issue: IssueSchema,
  repository: RepositorySchema,
  sender: SenderSchema,
})

type IssueOpenedPayload = typeof IssueOpenedPayloadSchema.Type

export const IssueCommentPayloadSchema = Schema.Struct({
  issue: IssueSchema,
  repository: RepositorySchema,
  sender: SenderSchema,
  comment: Schema.Struct({
    id: Schema.optional(Schema.NullOr(Schema.Number)),
    body: Schema.optional(Schema.NullOr(Schema.String)),
    html_url: Schema.optional(Schema.NullOr(Schema.String)),
    author_association: Schema.optional(Schema.NullOr(Schema.String)),
    updated_at: Schema.optional(Schema.NullOr(Schema.String)),
    user: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          login: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  }),
})

export type IssueCommentPayload = typeof IssueCommentPayloadSchema.Type

const AUTOMATION_SKIP_MARKERS = ['codex:skip-automation']

const hasAutomationSkipMarker = (body: string) => {
  const normalized = body.toLowerCase()
  return AUTOMATION_SKIP_MARKERS.some((marker) => normalized.includes(marker))
}

const hasAutomationSkipLabel = (labels: IssueOpenedPayload['issue']['labels']) =>
  labels?.some((label) => {
    const name = typeof label?.name === 'string' ? label.name.toLowerCase().trim() : ''
    return name === 'codex-control-plane' || name === 'codex-manual'
  }) ?? false

export const handleIssueOpened = async (params: BaseIssueParams): Promise<WorkflowStage | null> => {
  const { parsedPayload, headers, config, executionContext, deliveryId, senderLogin } = params

  if (!isGithubIssueEvent(parsedPayload)) {
    return null
  }

  let payload: IssueOpenedPayload
  try {
    payload = Schema.decodeUnknownSync(IssueOpenedPayloadSchema)(parsedPayload)
  } catch {
    return null
  }

  const issue = payload.issue
  const repository = payload.repository
  const senderLoginValue = payload.sender?.login ?? senderLogin
  const issueNumber = issue?.number

  if (typeof issueNumber !== 'number') {
    return null
  }

  const issueAuthor = normalizeLogin(issue?.user?.login)
  const isAuthorizedIssueAuthor =
    typeof issueAuthor === 'string' ? config.codexTriggerLogins.includes(issueAuthor) : false
  if (!isAuthorizedIssueAuthor) {
    return null
  }

  const repositoryFullName = deriveRepositoryFullName(repository, issue?.repository_url)
  if (!repositoryFullName) {
    return null
  }

  const issueBody = typeof issue?.body === 'string' ? issue.body : ''
  if (hasAutomationSkipMarker(issueBody) || hasAutomationSkipLabel(issue?.labels)) {
    logger.info({ repositoryFullName, issueNumber }, 'Skipping codex automation for issue')
    return null
  }

  const isPullRequestIssue = Boolean(issue?.pull_request?.url ?? issue?.pull_request?.html_url)
  if (!isPullRequestIssue) {
    const reactionResult = await executionContext.runGithub(() =>
      executionContext.githubService.postIssueReaction({
        repositoryFullName,
        issueNumber,
        reactionContent: '+1',
        token: config.github.token,
        apiBaseUrl: config.github.apiBaseUrl,
        userAgent: config.github.userAgent,
      }),
    )

    if (!reactionResult.ok) {
      logger.warn(
        {
          repositoryFullName,
          issueNumber,
          reason: reactionResult.reason,
          status: reactionResult.status,
        },
        'failed to post thumbs up reaction on issue',
      )
    }
  }

  const baseBranch = repository?.default_branch ?? config.codebase.baseBranch
  const headBranch = buildCodexBranchName(issueNumber, deliveryId, config.codebase.branchPrefix)
  const issueTitle = typeof issue?.title === 'string' && issue.title.length > 0 ? issue.title : `Issue #${issueNumber}`
  const issueUrl = typeof issue?.html_url === 'string' ? issue.html_url : ''
  const metadata = parseCodexIssueMetadata(issueBody)
  const prompt = buildCodexPrompt({
    issueTitle,
    issueBody,
    repositoryFullName,
    issueNumber,
    baseBranch,
    headBranch,
    issueUrl,
  })

  const agentRunRequest: GithubIssueAgentRunRequest = {
    stage: 'implementation',
    prompt,
    repository: repositoryFullName,
    base: baseBranch,
    head: headBranch,
    issueNumber,
    issueUrl,
    issueTitle,
    issueBody,
    sender: typeof senderLoginValue === 'string' ? senderLoginValue : '',
    issuedAt: new Date().toISOString(),
    metadataVersion: metadata.version ?? undefined,
    iterations: metadata.iterations,
  }

  const implementationCommand: ImplementationCommand = {
    stage: 'implementation',
    key: `issue-${issueNumber}-implementation`,
    agentRun: {
      deliveryId,
      payload: buildGithubIssueAgentRunPayload(config.agents, agentRunRequest, deliveryId),
    },
  } as ImplementationCommand

  const { stage } = await executeWorkflowCommands(
    [{ type: 'submitImplementation', data: implementationCommand }],
    executionContext,
  )
  return stage ?? null
}

export const handleIssueCommentCreated = async (params: BaseIssueParams): Promise<WorkflowStage | null> => {
  const { parsedPayload, headers, config, executionContext, deliveryId } = params

  if (!isGithubIssueCommentEvent(parsedPayload)) {
    return null
  }

  let payload: IssueCommentPayload
  try {
    payload = Schema.decodeUnknownSync(IssueCommentPayloadSchema)(parsedPayload)
  } catch {
    return null
  }

  const rawCommentBody = typeof payload.comment?.body === 'string' ? payload.comment.body : ''
  const trimmedCommentBody = rawCommentBody.trim()
  const senderLoginValue = payload.sender?.login
  const normalizedSender = normalizeLogin(senderLoginValue)
  const isAuthorizedSender =
    typeof normalizedSender === 'string' ? config.codexTriggerLogins.includes(normalizedSender) : false
  const isManualTrigger = trimmedCommentBody === config.codexImplementationTriggerPhrase
  const shouldTriggerImplementation = isAuthorizedSender && isManualTrigger

  if (!shouldTriggerImplementation) {
    return null
  }

  const issue = payload.issue
  const issueRepository = selectReactionRepository(issue, payload.repository)
  const repositoryFullName = deriveRepositoryFullName(issueRepository, issue?.repository_url)
  const issueNumber = typeof issue?.number === 'number' ? issue.number : undefined
  const isPullRequestComment = Boolean(issue?.pull_request?.url ?? issue?.pull_request?.html_url)
  const commentId = payload.comment?.id

  if (!issueNumber || !repositoryFullName) {
    return null
  }

  if (isPullRequestComment && typeof commentId === 'number') {
    const reactionResult = await executionContext.runGithub(() =>
      executionContext.githubService.postIssueCommentReaction({
        repositoryFullName,
        commentId,
        reactionContent: 'eyes',
        token: config.github.token,
        apiBaseUrl: config.github.apiBaseUrl,
        userAgent: config.github.userAgent,
      }),
    )

    if (!reactionResult.ok) {
      logger.warn(
        {
          repositoryFullName,
          issueNumber,
          commentId,
          reason: reactionResult.reason,
          status: reactionResult.status,
        },
        'failed to post eyes reaction on pull request comment',
      )
    }
  }

  if (!isPullRequestComment) {
    const reactionResult = await executionContext.runGithub(() =>
      executionContext.githubService.postIssueReaction({
        repositoryFullName,
        issueNumber,
        reactionContent: '+1',
        token: config.github.token,
        apiBaseUrl: config.github.apiBaseUrl,
        userAgent: config.github.userAgent,
      }),
    )

    if (!reactionResult.ok) {
      logger.warn(
        {
          repositoryFullName,
          issueNumber,
          reason: reactionResult.reason,
          status: reactionResult.status,
        },
        'failed to post thumbs up reaction on issue',
      )
    }
  }

  const baseBranch = issueRepository?.default_branch ?? config.codebase.baseBranch
  const headBranch = buildCodexBranchName(issueNumber, deliveryId, config.codebase.branchPrefix)
  const issueTitle = typeof issue?.title === 'string' && issue.title.length > 0 ? issue.title : `Issue #${issueNumber}`
  const issueBody = typeof issue?.body === 'string' ? issue.body : ''
  const issueUrl = typeof issue?.html_url === 'string' ? issue.html_url : ''
  const metadata = parseCodexIssueMetadata(issueBody)

  const prompt = buildCodexPrompt({
    issueTitle,
    issueBody,
    repositoryFullName,
    issueNumber,
    baseBranch,
    headBranch,
    issueUrl,
  })

  const agentRunRequest: GithubIssueAgentRunRequest = {
    stage: 'implementation',
    prompt,
    repository: repositoryFullName,
    base: baseBranch,
    head: headBranch,
    issueNumber,
    issueUrl,
    issueTitle,
    issueBody,
    sender: typeof senderLoginValue === 'string' ? senderLoginValue : '',
    issuedAt: new Date().toISOString(),
    metadataVersion: metadata.version ?? undefined,
    iterations: metadata.iterations,
  }

  const implementationCommand: ImplementationCommand = {
    stage: 'implementation',
    key: `issue-${issueNumber}-implementation`,
    agentRun: {
      deliveryId,
      payload: buildGithubIssueAgentRunPayload(config.agents, agentRunRequest, deliveryId),
    },
  } as ImplementationCommand

  const { stage } = await executeWorkflowCommands(
    [{ type: 'submitImplementation', data: implementationCommand }],
    executionContext,
  )
  return stage ?? null
}
