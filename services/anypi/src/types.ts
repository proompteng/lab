export type JsonRecord = Record<string, unknown>

export type AgentRunIdentity = {
  name?: string
  namespace?: string
}

export type ImplementationPayload = {
  summary?: string
  text?: string
}

export type VcsContext = {
  provider?: string
  providerName?: string
  repository?: string
  baseBranch?: string
  headBranch?: string
  mode?: string
  writeEnabled?: boolean
  pullRequestsEnabled?: boolean
  apiBaseUrl?: string
  cloneBaseUrl?: string
  webBaseUrl?: string
  cloneProtocol?: string
}

export type AgentRunSpecPayload = {
  provider?: string
  agentRun?: AgentRunIdentity
  implementation?: ImplementationPayload
  parameters?: Record<string, string>
  systemPrompt?: string
  prompt?: string
  goal?: {
    objective?: string
    tokenBudget?: number
  }
  repository?: string
  base?: string
  head?: string
  issueTitle?: string
  issueBody?: string
  vcs?: VcsContext
}

export type AgentRunnerSpecPayload = {
  provider?: string
  artifacts?: {
    statusPath?: string
    logPath?: string
    logRetentionSeconds?: number
  }
  payloads?: {
    eventFilePath?: string
  }
}

export type CommandResult = {
  command: string
  args: string[]
  cwd?: string
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}

export type ValidationResult = CommandResult & {
  ok: boolean
}

export type PullRequestResult = {
  enabled: boolean
  url?: string
  created?: boolean
}

export type AnypiStatus = {
  provider: string
  status: 'running' | 'succeeded' | 'failed'
  startedAt: string
  finishedAt?: string
  runName?: string
  namespace?: string
  repository?: string
  baseBranch?: string
  headBranch?: string
  worktree?: string
  model: string
  providerModel: string
  tools: string[]
  sessionFile?: string
  sessionFiles?: string[]
  commit?: string
  pullRequest?: PullRequestResult
  validations: ValidationResult[]
  agentAttempts: number
  validationAttempts: number
  promptChars: number
  error?: string
}
