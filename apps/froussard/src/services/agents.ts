import {
  submitAgentRunToAgentsService,
  type AgentsAgentRunSubmitInput,
  type AgentsServiceJsonResult,
} from '@proompteng/agent-contracts/agent-runs-client'

import type { CodexTaskMessage } from '@/codex'
import type { AppConfig } from '@/config'

export type FroussardAgentsConfig = AppConfig['agents']

export type AgentRunSubmission = AgentsAgentRunSubmitInput

export type AgentRunSubmitter = (input: AgentRunSubmission) => Promise<AgentsServiceJsonResult<Record<string, unknown>>>

const optionalString = (value: string | undefined | null) => {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : undefined
}

const issueExternalId = (message: CodexTaskMessage) => `${message.repository}#${message.issueNumber}`

export const buildGithubIssueAgentRunPayload = (
  config: FroussardAgentsConfig,
  message: CodexTaskMessage,
  deliveryId: string,
): Record<string, unknown> => ({
  namespace: config.namespace,
  agentRef: { name: config.agentName },
  implementation: {
    summary: message.issueTitle || `Implement ${issueExternalId(message)}`,
    text: message.prompt,
    source: {
      provider: 'github',
      externalId: issueExternalId(message),
      ...(optionalString(message.issueUrl) ? { url: message.issueUrl } : {}),
    },
    contract: {
      requiredKeys: ['repository', 'issueNumber', 'base', 'head', 'stage'],
    },
    metadata: {
      stage: 'implementation',
      deliveryId,
      sender: message.sender,
      issuedAt: message.issuedAt,
      ...(message.metadataVersion != null ? { metadataVersion: message.metadataVersion } : {}),
      ...(message.iterations ? { iterations: message.iterations } : {}),
    },
  },
  goal: {
    objective: message.prompt,
    tokenBudget: config.goalTokenBudget,
  },
  runtime: {
    type: 'job',
    config: {
      serviceAccountName: config.serviceAccountName,
    },
  },
  parameters: {
    repository: message.repository,
    issueNumber: String(message.issueNumber),
    issue_number: String(message.issueNumber),
    base: message.base,
    head: message.head,
    stage: 'implementation',
    deliveryId,
    codexPrompt: message.prompt,
    codex_prompt: message.prompt,
    issueTitle: message.issueTitle,
    issueBody: message.issueBody,
    ...(optionalString(message.issueUrl) ? { issueUrl: message.issueUrl } : {}),
    ...(message.metadataVersion != null ? { metadataVersion: String(message.metadataVersion) } : {}),
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
