import type { DiscordResponseConfig } from '@/discord-commands'

export interface WebhookConfig {
  atlas: {
    baseUrl: string
    apiKey: string | null
  }
  agents: {
    serviceBaseUrl: string
    serviceClientName: string
    namespace: string
    agentName: string
    linearAgentName: string
    vcsProviderName: string
    serviceAccountName: string
    secrets: string[]
    secretBindingRef: string
    ttlSecondsAfterFinished: number
    goalTokenBudget: number
  }
  codebase: {
    baseBranch: string
    branchPrefix: string
  }
  github: {
    token: string | null
    ackReaction: string
    apiBaseUrl: string
    userAgent: string
  }
  codexTriggerLogins: readonly string[]
  codexWorkflowLogin: string
  codexImplementationTriggerPhrase: string
  topics: {
    raw: string
    discordCommands: string
    linearRaw: string
  }
  discord: {
    publicKey: string
    response: DiscordResponseConfig
  }
  idempotency: {
    ttlMs: number
    maxEntries: number
  }
  linear: {
    enabled?: boolean
    webhookSecret: string
    triggerLabel: string
    repository: string
    baseBranch: string
    branchPrefix: string
    maxBodyBytes: number
    webhookToleranceMs: number
    agentsTimeoutMs: number
  }
}
