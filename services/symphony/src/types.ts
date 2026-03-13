import type { AskForApproval, RateLimitSnapshot, SandboxMode, SandboxPolicy } from '@proompteng/codex'

export type BlockerRef = {
  id: string | null
  identifier: string | null
  state: string | null
}

export type Issue = {
  id: string
  identifier: string
  title: string
  description: string | null
  priority: number | null
  state: string
  branchName: string | null
  url: string | null
  labels: string[]
  blockedBy: BlockerRef[]
  createdAt: string | null
  updatedAt: string | null
}

export type WorkflowDefinition = {
  config: Record<string, unknown>
  promptTemplate: string
}

export type WorkflowHooks = {
  afterCreate: string | null
  beforeRun: string | null
  afterRun: string | null
  beforeRemove: string | null
  timeoutMs: number
}

export type TrackerConfig = {
  kind: string | null
  endpoint: string
  apiKey: string | null
  projectSlug: string | null
  activeStates: string[]
  terminalStates: string[]
}

export type WorkerConfig = {
  sshHosts: string[]
  maxConcurrentAgentsPerHost: number | null
}

export type AgentConfig = {
  maxConcurrentAgents: number
  maxConcurrentAgentsByState: Record<string, number>
  maxRetryBackoffMs: number
  maxTurns: number
}

export type CodexConfig = {
  command: string
  approvalPolicy: AskForApproval | null
  threadSandbox: SandboxMode | null
  turnSandboxPolicy: SandboxPolicy | null
  turnTimeoutMs: number
  readTimeoutMs: number
  stallTimeoutMs: number
}

export type ServerConfig = {
  host: string
  port: number | null
}

export type SymphonyConfig = {
  workflowPath: string
  tracker: TrackerConfig
  pollingIntervalMs: number
  workspaceRoot: string
  hooks: WorkflowHooks
  worker: WorkerConfig
  agent: AgentConfig
  codex: CodexConfig
  server: ServerConfig
}

export type WorkspaceInfo = {
  path: string
  workspaceKey: string
  createdNow: boolean
}

export type TokenUsageTotals = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export type LiveSession = {
  sessionId: string | null
  threadId: string | null
  turnId: string | null
  codexAppServerPid: string | null
  lastCodexEvent: string | null
  lastCodexTimestamp: string | null
  lastCodexMessage: string | null
  codexInputTokens: number
  codexOutputTokens: number
  codexTotalTokens: number
  lastReportedInputTokens: number
  lastReportedOutputTokens: number
  lastReportedTotalTokens: number
  turnCount: number
}

export type RecentEvent = {
  at: string
  event: string
  message: string | null
}

export type RetryEntry = {
  issueId: string
  identifier: string
  attempt: number
  dueAtMs: number
  timerHandle: Timer
  error: string | null
}

export type RunningEntry = {
  issue: Issue
  issueId: string
  identifier: string
  retryAttempt: number | null
  workspacePath: string
  startedAt: string
  startedAtMs: number
  session: LiveSession
  lastError: string | null
  recentEvents: RecentEvent[]
  workerHandle: Promise<void>
  abortController: AbortController
  stopReason: 'running' | 'stalled' | 'terminal' | 'inactive'
  terminalCleanupRequested: boolean
}

export type CodexTotals = TokenUsageTotals & {
  endedRuntimeSeconds: number
}

export type RuntimeSnapshot = {
  generatedAt: string
  counts: {
    running: number
    retrying: number
  }
  running: Array<{
    issueId: string
    issueIdentifier: string
    state: string
    sessionId: string | null
    turnCount: number
    lastEvent: string | null
    lastMessage: string | null
    startedAt: string
    lastEventAt: string | null
    tokens: TokenUsageTotals
  }>
  retrying: Array<{
    issueId: string
    issueIdentifier: string
    attempt: number
    dueAt: string
    error: string | null
  }>
  codexTotals: TokenUsageTotals & {
    secondsRunning: number
  }
  rateLimits: RateLimitSnapshot | null
}
