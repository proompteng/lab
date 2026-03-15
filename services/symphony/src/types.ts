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

export type LoadedWorkflow = {
  definition: WorkflowDefinition
  config: SymphonyConfig
  mtimeMs: number
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
  issueId?: string | null
  issueIdentifier?: string | null
  level?: 'info' | 'warn' | 'error'
  reason?: string | null
}

export type CodexTotals = TokenUsageTotals & {
  endedRuntimeSeconds: number
}

export type RecentError = {
  at: string
  code: string
  message: string
  issueId: string | null
  issueIdentifier: string | null
  context: string
}

export type PolicySummary = {
  approvalPolicy: AskForApproval | null
  threadSandbox: string | null
  turnSandboxPolicy: SandboxPolicy | null
  allowedTools: string[]
  workspaceRoot: string
  pollIntervalMs: number
  maxConcurrentAgents: number
  activeStates: string[]
  terminalStates: string[]
}

export type WorkflowSummary = {
  workflowPath: string
  trackerKind: string | null
  projectSlug: string | null
  promptTemplateEmpty: boolean
}

export type LeaderSnapshot = {
  enabled: boolean
  required: boolean
  isLeader: boolean
  leaseName: string | null
  leaseNamespace: string | null
  identity: string
  lastTransitionAt: string | null
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
}

export type CapacitySnapshot = {
  maxConcurrentAgents: number
  running: number
  retrying: number
  availableSlots: number
  saturated: boolean
  byState: Array<{
    state: string
    running: number
    limit: number
    saturated: boolean
  }>
}

export type RunHistoryEntry = {
  at: string
  status:
    | 'started'
    | 'workspace_ready'
    | 'retry_scheduled'
    | 'succeeded'
    | 'failed'
    | 'stalled'
    | 'terminal'
    | 'inactive'
    | 'leadership_lost'
    | 'restored'
  attempt: number | null
  message: string | null
  workspacePath: string | null
  sessionId: string | null
}

export type SessionLogRef = {
  label: string
  path: string | null
  url: string | null
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
  policy: PolicySummary
  workflow: WorkflowSummary
  leader: LeaderSnapshot
  recentEvents: RecentEvent[]
  recentErrors: RecentError[]
  capacity: CapacitySnapshot
}

export type IssueDetails = {
  issueIdentifier: string
  issueId: string
  status: 'running' | 'retrying' | 'tracked'
  workspace: {
    path: string | null
  }
  attempts: {
    restartCount: number
    currentRetryAttempt: number
  }
  running: {
    sessionId: string | null
    turnCount: number
    state: string
    startedAt: string
    lastEvent: string | null
    lastMessage: string | null
    lastEventAt: string | null
    tokens: TokenUsageTotals
  } | null
  retry: {
    attempt: number
    dueAt: string
    error: string | null
  } | null
  logs: {
    codex_session_logs: SessionLogRef[]
  }
  recentEvents: RecentEvent[]
  lastError: string | null
  tracked: Record<string, unknown>
  runHistory: RunHistoryEntry[]
}

export type IssueRecord = {
  issueIdentifier: string
  issueId: string
  status: IssueDetails['status']
  workspacePath: string | null
  attempts: IssueDetails['attempts']
  running: IssueDetails['running']
  retry: IssueDetails['retry']
  logs: IssueDetails['logs']
  recentEvents: RecentEvent[]
  lastError: string | null
  tracked: Record<string, unknown>
  runHistory: RunHistoryEntry[]
  updatedAt: string
}

export type PersistedRetryEntry = {
  issueId: string
  identifier: string
  attempt: number
  dueAt: string
  error: string | null
}

export type PersistedSchedulerState = {
  version: 1
  updatedAt: string
  codexTotals: CodexTotals
  rateLimits: RateLimitSnapshot | null
  recentEvents: RecentEvent[]
  recentErrors: RecentError[]
  retrying: PersistedRetryEntry[]
  issues: IssueRecord[]
}
