export type JsonRecord = Record<string, unknown>

export type PromptVariant = 'minimal' | 'finish-gated' | 'repair-loop' | 'strict-repo'

export type ValidationPolicy = 'append' | 'override'

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

export type ValidationPlan = {
  policy: ValidationPolicy
  sources: string[]
  commands: string[]
}

export type PullRequestResult = {
  enabled: boolean
  url?: string
  created?: boolean
}

export type CiCheck = {
  name: string
  workflow?: string
  state?: string
  bucket?: string
  link?: string
}

export type CiWaitResult = {
  ok: boolean
  status: 'passed' | 'failed' | 'timed-out' | 'unavailable'
  requiredOnly: boolean
  attempts: number
  durationMs: number
  checks: CiCheck[]
  summary: string
}

export type TimeoutArtifacts = {
  gitStatus: string
  diffStat?: string
  headBranch?: string
  uncommittedPatchPath?: string
  logPath?: string
  statusPath?: string
  sessionPath?: string
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
  piPromptTimeoutSeconds: number
  promptVariant: PromptVariant
  promptHash: string
  tools: string[]
  sessionFile?: string
  sessionFiles?: string[]
  commit?: string
  pullRequest?: PullRequestResult
  ci?: CiWaitResult
  ciAttempts: number
  validations: ValidationResult[]
  validationPlan: ValidationPlan
  agentAttempts: number
  validationAttempts: number
  promptChars: number
  error?: string
  timeoutArtifacts?: TimeoutArtifacts
}
