import {
  submitAgentRunToAgentsService,
  type AgentsAgentRunSubmitInput,
  type AgentsServiceJsonResult,
} from '@proompteng/agent-contracts'

import type { GithubIssueAgentRunRequest } from '@/codex'
import type { AppConfig } from '@/config'

export type FroussardAgentsConfig = AppConfig['agents']

export type AgentRunSubmission = AgentsAgentRunSubmitInput

export type AgentRunSubmitter = (input: AgentRunSubmission) => Promise<AgentsServiceJsonResult<Record<string, unknown>>>

export interface LinearIssueAgentRunRequest {
  issueId: string
  identifier: string
  title: string
  description: string
  url: string
  action: 'create' | 'update'
  repository: string
  base: string
  head: string
}

const optionalString = (value: string | undefined | null) => {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : undefined
}

const issueExternalId = (request: GithubIssueAgentRunRequest) => `${request.repository}#${request.issueNumber}`

const maxGoalObjectiveLength = 4000
const truncatedObjectiveSuffix = '\n...'

const truncateGoalObjective = (objective: string) => {
  if (objective.length <= maxGoalObjectiveLength) return objective
  return `${objective.slice(0, maxGoalObjectiveLength - truncatedObjectiveSuffix.length).trimEnd()}${truncatedObjectiveSuffix}`
}

export const buildGithubIssueGoalObjective = (request: GithubIssueAgentRunRequest): string =>
  truncateGoalObjective(
    [
      `Implement GitHub issue ${issueExternalId(request)}: ${request.issueTitle}.`,
      `Issue URL: ${request.issueUrl}.`,
      `Base branch: ${request.base}.`,
      `Head branch: ${request.head}.`,
      'Use implementation.text for the full issue body, requirements, and acceptance criteria.',
    ].join('\n'),
  )

export const buildGithubIssueAgentRunPayload = (
  config: FroussardAgentsConfig,
  request: GithubIssueAgentRunRequest,
  deliveryId: string,
): Record<string, unknown> => ({
  namespace: config.namespace,
  agentRef: { name: config.agentName },
  implementation: {
    summary: request.issueTitle || `Implement ${issueExternalId(request)}`,
    text: request.prompt,
    source: {
      provider: 'github',
      externalId: issueExternalId(request),
      ...(optionalString(request.issueUrl) ? { url: request.issueUrl } : {}),
    },
    contract: {
      requiredKeys: ['repository', 'issueNumber', 'base', 'head', 'stage'],
    },
    metadata: {
      stage: 'implementation',
      deliveryId,
      sender: request.sender,
      issuedAt: request.issuedAt,
      ...(request.metadataVersion != null ? { metadataVersion: request.metadataVersion } : {}),
      ...(request.iterations ? { iterations: request.iterations } : {}),
    },
  },
  goal: {
    objective: buildGithubIssueGoalObjective(request),
    tokenBudget: config.goalTokenBudget,
  },
  runtime: {
    type: 'job',
    config: {
      serviceAccountName: config.serviceAccountName,
    },
  },
  parameters: {
    repository: request.repository,
    issueNumber: String(request.issueNumber),
    issue_number: String(request.issueNumber),
    base: request.base,
    head: request.head,
    stage: 'implementation',
    deliveryId,
    issueTitle: request.issueTitle,
    ...(optionalString(request.issueUrl) ? { issueUrl: request.issueUrl } : {}),
    ...(request.metadataVersion != null ? { metadataVersion: String(request.metadataVersion) } : {}),
  },
  secrets: config.secrets,
  policy: {
    secretBindingRef: config.secretBindingRef,
  },
  vcsRef: { name: config.vcsProviderName },
  vcsPolicy: { required: true, mode: 'read-write' },
  ttlSecondsAfterFinished: config.ttlSecondsAfterFinished,
})

export const buildLinearIssueGoalObjective = (request: LinearIssueAgentRunRequest): string =>
  truncateGoalObjective(
    [
      `Implement Linear issue ${request.identifier}: ${request.title}.`,
      `Issue URL: ${request.url}.`,
      `Base branch: ${request.base}.`,
      `Head branch: ${request.head}.`,
      'Use implementation.text for the full issue requirements and acceptance criteria.',
    ].join('\n'),
  )

export const buildLinearIssueAgentRunPayload = (
  config: FroussardAgentsConfig,
  request: LinearIssueAgentRunRequest,
  deliveryId: string,
): Record<string, unknown> => ({
  namespace: config.namespace,
  agentRef: { name: config.linearAgentName },
  idempotencyKey: deliveryId,
  implementation: {
    summary: request.title || `Implement ${request.identifier}`,
    text: request.description,
    source: {
      provider: 'linear',
      externalId: request.identifier,
      url: request.url,
    },
    contract: {
      requiredKeys: ['repository', 'base', 'head', 'stage'],
    },
    metadata: {
      issueId: request.issueId,
      deliveryId,
      action: request.action,
      sourceVersion: 1,
    },
  },
  goal: {
    objective: buildLinearIssueGoalObjective(request),
  },
  runtime: {
    type: 'job',
    config: {},
  },
  parameters: {
    repository: request.repository,
    base: request.base,
    head: request.head,
    stage: 'implementation',
  },
  secrets: config.secrets,
  policy: {
    secretBindingRef: config.secretBindingRef,
  },
  vcsRef: { name: config.vcsProviderName },
  vcsPolicy: { required: true, mode: 'read-write' },
  ttlSecondsAfterFinished: config.ttlSecondsAfterFinished,
})

export const makeAgentsServiceSubmitter =
  (config: FroussardAgentsConfig): AgentRunSubmitter =>
  (input) =>
    submitAgentRunToAgentsService(input, {
      AGENTS_SERVICE_BASE_URL: config.serviceBaseUrl,
      AGENTS_SERVICE_CLIENT_NAME: config.serviceClientName,
    })
