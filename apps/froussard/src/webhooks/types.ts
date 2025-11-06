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
  codexTriggerLogin: string
  codexWorkflowLogin: string
  codexImplementationTriggerPhrase: string
  topics: {
    raw: string
    codex: string
    codexStructured: string
    discordCommands: string
  }
  discord: {
    publicKey: string
    response: DiscordResponseConfig
  }
  flags?: {
    skipPlanningPlaceholder?: boolean
  }
}
