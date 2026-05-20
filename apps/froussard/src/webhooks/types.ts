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
  }
  discord: {
    publicKey: string
    response: DiscordResponseConfig
  }
  idempotency: {
    ttlMs: number
    maxEntries: number
  }
}
