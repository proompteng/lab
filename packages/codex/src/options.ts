export type ApprovalMode = 'never' | 'on-request' | 'on-failure' | 'untrusted'

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export type ModelReasoningEffort = 'minimal' | 'low' | 'medium' | 'high'

export interface CodexOptions {
  codexPathOverride?: string
  baseUrl?: string
  apiKey?: string
}

export interface ThreadOptions {
  model?: string
  sandboxMode?: SandboxMode
  workingDirectory?: string
  skipGitRepoCheck?: boolean
  modelReasoningEffort?: ModelReasoningEffort
  networkAccessEnabled?: boolean
  webSearchEnabled?: boolean
  approvalPolicy?: ApprovalMode
  additionalDirectories?: string[]
}

export interface TurnOptions {
  signal?: AbortSignal
}
