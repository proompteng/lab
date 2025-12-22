import type { DiscordResponseConfig } from '@/discord-commands'

export interface WebhookConfig {
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
    codexStructured: string
    discordCommands: string
  }
  discord: {
    publicKey: string
    response: DiscordResponseConfig
  }
}
