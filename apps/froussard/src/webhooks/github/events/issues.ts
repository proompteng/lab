import { Schema } from 'effect'

import { buildCodexBranchName, buildCodexPrompt, type CodexTaskMessage, normalizeLogin } from '@/codex'
import type { ImplementationCommand } from '@/codex/workflow-machine'
import { selectReactionRepository } from '@/codex-workflow'
import { deriveRepositoryFullName, isGithubIssueCommentEvent, isGithubIssueEvent } from '@/github-payload'
import { logger } from '@/logger'
import type { WebhookConfig } from '../../types'
import { PROTO_CODEX_TASK_FULL_NAME, PROTO_CODEX_TASK_SCHEMA, PROTO_CONTENT_TYPE } from '../constants'
import { toCodexTaskProto } from '../payloads'
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

const SenderSchema = Schema.optionalWith(
  Schema.Struct({
    login: Schema.optionalWith(Schema.String, { nullable: true }),
  }),
  { nullable: true, default: () => ({}) },
)

const RepositoryValueSchema = Schema.Struct({
  full_name: Schema.optionalWith(Schema.String, { nullable: true }),
  default_branch: Schema.optionalWith(Schema.String, { nullable: true }),
})

const RepositorySchema = Schema.optionalWith(RepositoryValueSchema, { nullable: true, default: () => ({}) })

const IssueSchema = Schema.Struct({
  number: Schema.Number,
  title: Schema.optionalWith(Schema.String, { nullable: true }),
  body: Schema.optionalWith(Schema.String, { nullable: true }),
  html_url: Schema.optionalWith(Schema.String, { nullable: true }),
  repository_url: Schema.optionalWith(Schema.String, { nullable: true }),
  repository: Schema.optionalWith(RepositoryValueSchema, { nullable: true }),
  pull_request: Schema.optionalWith(
    Schema.Struct({
      url: Schema.optionalWith(Schema.String, { nullable: true }),
      html_url: Schema.optionalWith(Schema.String, { nullable: true }),
    }),
    { nullable: true },
  ),
  user: Schema.optionalWith(
    Schema.Struct({
      login: Schema.optionalWith(Schema.String, { nullable: true }),
    }),
    { nullable: true },
  ),
})

const IssueOpenedPayloadSchema = Schema.Struct({
  issue: IssueSchema,
  repository: RepositorySchema,
  sender: SenderSchema,
})

type IssueOpenedPayload = Schema.Schema.Type<typeof IssueOpenedPayloadSchema>

export const IssueCommentPayloadSchema = Schema.Struct({
  issue: IssueSchema,
  repository: RepositorySchema,
  sender: SenderSchema,
  comment: Schema.Struct({
    id: Schema.optionalWith(Schema.Number, { nullable: true }),
    body: Schema.optionalWith(Schema.String, { nullable: true }),
    html_url: Schema.optionalWith(Schema.String, { nullable: true }),
    author_association: Schema.optionalWith(Schema.String, { nullable: true }),
    updated_at: Schema.optionalWith(Schema.String, { nullable: true }),
    user: Schema.optionalWith(
      Schema.Struct({
        login: Schema.optionalWith(Schema.String, { nullable: true }),
      }),
      { nullable: true },
    ),
  }),
})

export type IssueCommentPayload = Schema.Schema.Type<typeof IssueCommentPayloadSchema>

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
  const issueBody = typeof issue?.body === 'string' ? issue.body : ''
  const issueUrl = typeof issue?.html_url === 'string' ? issue.html_url : ''
  const prompt = buildCodexPrompt({
    issueTitle,
    issueBody,
    repositoryFullName,
    issueNumber,
    baseBranch,
    headBranch,
    issueUrl,
  })

  const codexMessage: CodexTaskMessage = {
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
  }

  const codexStructuredMessage = toCodexTaskProto(codexMessage, deliveryId)

  const implementationCommand: ImplementationCommand = {
    stage: 'implementation',
    key: `issue-${issueNumber}-implementation`,
    structuredMessage: codexStructuredMessage,
    topics: {
      codexStructured: config.topics.codexStructured,
    },
    structuredHeaders: {
      ...headers,
      'x-codex-task-stage': 'implementation',
      'content-type': PROTO_CONTENT_TYPE,
      'x-protobuf-message': PROTO_CODEX_TASK_FULL_NAME,
      'x-protobuf-schema': PROTO_CODEX_TASK_SCHEMA,
    },
  } as ImplementationCommand

  const { stage } = await executeWorkflowCommands(
    [{ type: 'publishImplementation', data: implementationCommand }],
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

  const prompt = buildCodexPrompt({
    issueTitle,
    issueBody,
    repositoryFullName,
    issueNumber,
    baseBranch,
    headBranch,
    issueUrl,
  })

  const codexMessage: CodexTaskMessage = {
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
  }

  const codexStructuredMessage = toCodexTaskProto(codexMessage, deliveryId)

  const implementationCommand: ImplementationCommand = {
    stage: 'implementation',
    key: `issue-${issueNumber}-implementation`,
    structuredMessage: codexStructuredMessage,
    topics: {
      codexStructured: config.topics.codexStructured,
    },
    structuredHeaders: {
      ...headers,
      'x-codex-task-stage': 'implementation',
      'content-type': PROTO_CONTENT_TYPE,
      'x-protobuf-message': PROTO_CODEX_TASK_FULL_NAME,
      'x-protobuf-schema': PROTO_CODEX_TASK_SCHEMA,
    },
  } as ImplementationCommand

  const { stage } = await executeWorkflowCommands(
    [{ type: 'publishImplementation', data: implementationCommand }],
    executionContext,
  )
  return stage ?? null
}
