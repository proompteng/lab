import { buildCodexBranchName, buildCodexPrompt, type CodexTaskMessage, normalizeLogin } from '@/codex'
import { evaluateCodexWorkflow, type ImplementationCommand, type PlanningCommand } from '@/codex/workflow-machine'
import { selectReactionRepository } from '@/codex-workflow'
import { deriveRepositoryFullName, isGithubIssueCommentEvent, isGithubIssueEvent } from '@/github-payload'
import type { WorkflowStage, WorkflowExecutionContext } from '../workflow'
import { executeWorkflowCommands } from '../workflow'
import type { WebhookConfig } from '../types'
import {
  CODEX_PLAN_MARKER,
  PROTO_CODEX_TASK_FULL_NAME,
  PROTO_CODEX_TASK_SCHEMA,
  PROTO_CONTENT_TYPE,
} from '../constants'
import { toCodexTaskProto } from '../payloads'

interface BaseIssueParams {
  parsedPayload: Record<string, any>
  headers: Record<string, string>
  config: WebhookConfig
  executionContext: WorkflowExecutionContext
  deliveryId: string
  senderLogin?: string
}

export const handleIssueOpened = async (params: BaseIssueParams): Promise<WorkflowStage | null> => {
  const { parsedPayload, headers, config, executionContext, deliveryId, senderLogin } = params

  if (!isGithubIssueEvent(parsedPayload)) {
    return null
  }

  const issue = parsedPayload.issue
  const repository = parsedPayload.repository
  const senderLoginValue = parsedPayload.sender?.login ?? senderLogin
  const issueNumber = issue?.number

  if (typeof issueNumber !== 'number') {
    return null
  }

  const issueAuthor = normalizeLogin(issue?.user?.login)
  if (issueAuthor !== config.codexTriggerLogin) {
    return null
  }

  const repositoryFullName = deriveRepositoryFullName(repository, issue?.repository_url)
  if (!repositoryFullName) {
    return null
  }

  const baseBranch = repository?.default_branch ?? config.codebase.baseBranch
  const headBranch = buildCodexBranchName(issueNumber, deliveryId, config.codebase.branchPrefix)
  const issueTitle = typeof issue?.title === 'string' && issue.title.length > 0 ? issue.title : `Issue #${issueNumber}`
  const issueBody = typeof issue?.body === 'string' ? issue.body : ''
  const issueUrl = typeof issue?.html_url === 'string' ? issue.html_url : ''
  const prompt = buildCodexPrompt({
    stage: 'planning',
    issueTitle,
    issueBody,
    repositoryFullName,
    issueNumber,
    baseBranch,
    headBranch,
    issueUrl,
  })

  const codexMessage: CodexTaskMessage = {
    stage: 'planning',
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

  const planningCommand: PlanningCommand = {
    stage: 'planning',
    key: `issue-${issueNumber}-planning`,
    codexMessage,
    structuredMessage: codexStructuredMessage,
    topics: {
      codex: config.topics.codex,
      codexStructured: config.topics.codexStructured,
    },
    jsonHeaders: {
      ...headers,
      'x-codex-task-stage': 'planning',
    },
    structuredHeaders: {
      ...headers,
      'x-codex-task-stage': 'planning',
      'content-type': PROTO_CONTENT_TYPE,
      'x-protobuf-message': PROTO_CODEX_TASK_FULL_NAME,
      'x-protobuf-schema': PROTO_CODEX_TASK_SCHEMA,
    },
    ack: {
      repositoryFullName,
      issueNumber,
      reaction: config.github.ackReaction,
    },
  } as PlanningCommand

  const evaluation = evaluateCodexWorkflow({
    type: 'ISSUE_OPENED',
    data: planningCommand,
  })

  const { stage } = await executeWorkflowCommands(evaluation.commands, executionContext)
  return stage ?? null
}

export const handleIssueCommentCreated = async (params: BaseIssueParams): Promise<WorkflowStage | null> => {
  const { parsedPayload, headers, config, executionContext, deliveryId } = params

  if (!isGithubIssueCommentEvent(parsedPayload)) {
    return null
  }

  const rawCommentBody = typeof parsedPayload.comment?.body === 'string' ? parsedPayload.comment.body : ''
  const trimmedCommentBody = rawCommentBody.trim()
  const senderLoginValue = parsedPayload.sender?.login
  const normalizedSender = normalizeLogin(senderLoginValue)
  const isAuthorizedSender = normalizedSender === config.codexTriggerLogin
  const isWorkflowSender = normalizedSender === config.codexWorkflowLogin
  const hasPlanMarker = rawCommentBody.includes(CODEX_PLAN_MARKER)
  const isManualTrigger = trimmedCommentBody === config.codexImplementationTriggerPhrase

  const shouldTriggerImplementation =
    (isAuthorizedSender && (isManualTrigger || hasPlanMarker)) || (hasPlanMarker && isWorkflowSender)

  if (!shouldTriggerImplementation) {
    return null
  }

  const issue = parsedPayload.issue
  const issueRepository = selectReactionRepository(issue, parsedPayload.repository)
  const repositoryFullName = deriveRepositoryFullName(issueRepository, issue?.repository_url)
  const issueNumber = typeof issue?.number === 'number' ? issue.number : undefined

  if (!issueNumber || !repositoryFullName) {
    return null
  }

  const baseBranch = issueRepository?.default_branch ?? config.codebase.baseBranch
  const headBranch = buildCodexBranchName(issueNumber, deliveryId, config.codebase.branchPrefix)
  const issueTitle = typeof issue?.title === 'string' && issue.title.length > 0 ? issue.title : `Issue #${issueNumber}`
  const issueBody = typeof issue?.body === 'string' ? issue.body : ''
  const issueUrl = typeof issue?.html_url === 'string' ? issue.html_url : ''

  let planCommentBody: string | undefined
  let planCommentId: number | undefined
  let planCommentUrl: string | undefined

  if (hasPlanMarker) {
    planCommentBody = rawCommentBody
    planCommentId = typeof parsedPayload.comment?.id === 'number' ? parsedPayload.comment.id : undefined
    planCommentUrl = typeof parsedPayload.comment?.html_url === 'string' ? parsedPayload.comment.html_url : undefined
  } else {
    const planLookup = await executionContext.runtime.runPromise(
      executionContext.githubService.findLatestPlanComment({
        repositoryFullName,
        issueNumber,
        token: config.github.token,
        apiBaseUrl: config.github.apiBaseUrl,
        userAgent: config.github.userAgent,
      }),
    )

    if (planLookup.ok) {
      planCommentBody = planLookup.comment.body
      planCommentId = planLookup.comment.id
      planCommentUrl = planLookup.comment.htmlUrl ?? undefined
    }
  }

  const prompt = buildCodexPrompt({
    stage: 'implementation',
    issueTitle,
    issueBody,
    repositoryFullName,
    issueNumber,
    baseBranch,
    headBranch,
    issueUrl,
    planCommentBody,
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
    planCommentBody,
    planCommentId,
    planCommentUrl,
  }

  const codexStructuredMessage = toCodexTaskProto(codexMessage, deliveryId)

  const implementationCommand: ImplementationCommand = {
    stage: 'implementation',
    key: `issue-${issueNumber}-implementation`,
    codexMessage,
    structuredMessage: codexStructuredMessage,
    topics: {
      codex: config.topics.codex,
      codexStructured: config.topics.codexStructured,
    },
    jsonHeaders: {
      ...headers,
      'x-codex-task-stage': 'implementation',
    },
    structuredHeaders: {
      ...headers,
      'x-codex-task-stage': 'implementation',
      'content-type': PROTO_CONTENT_TYPE,
      'x-protobuf-message': PROTO_CODEX_TASK_FULL_NAME,
      'x-protobuf-schema': PROTO_CODEX_TASK_SCHEMA,
    },
  } as ImplementationCommand

  const evaluation = evaluateCodexWorkflow({
    type: 'PLAN_APPROVED',
    data: implementationCommand,
  })

  const { stage } = await executeWorkflowCommands(evaluation.commands, executionContext)
  return stage ?? null
}
