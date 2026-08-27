export type AgentPhase = 'booting' | 'failed' | 'pending' | 'ready' | 'sleeping' | 'terminating' | 'unknown'
export type AgentArchitecture = 'amd64' | 'arm64' | 'unknown'

export type TengriCondition = {
  type: string
  status: string
  reason: string
  message: string
  lastTransitionAt: string
}

export type TengriAgent = {
  id: string
  displayName: string
  phase: AgentPhase
  architecture: AgentArchitecture
  cpuMillis: number
  memoryMib: number
  workspaceGib: number
  nodeName: string
  message: string
  createdAt: string
  readyAt: string
  lastActivityAt: string
  idleDeadline: string
  expiresAt: string
  conditions: TengriCondition[]
}

export type TengriUser = {
  id: string
  name: string
  email: string
  image: string | null
}

export type TengriDesktopSnapshot = {
  authConfigured: boolean
  controlPlaneConfigured: boolean
  previewGatewayOrigin: string
  authenticated: boolean
  user: TengriUser | null
  agents: TengriAgent[]
}

export type TengriFileEntry = {
  name: string
  path: string
  directory: boolean
  size: number
  modifiedAt: string
}

export type TengriFileEventKind = 'changed' | 'created' | 'removed' | 'renamed' | 'reset' | 'unknown'

export type TengriFileEvent = {
  sequence: number
  kind: TengriFileEventKind
  path: string
  previousPath: string
  entry: TengriFileEntry | null
}

export type TengriTerminalSession = {
  id: string
  cwd: string
  createdAt: string
  lastActivityAt: string
  attached: boolean
}

export type TengriTerminalTicket = {
  websocketUrl: string
  ticket: string
  expiresAt: string
}

export type TengriCodexAccount = {
  authenticated: boolean
  email: string
  plan: string
}

export type TengriCodexLogin = {
  loginId: string
  verificationUrl: string
  userCode: string
  expiresAt: string
}

export type TengriCodexThread = {
  id: string
  rawJson: string
}

export type TengriCodexTurn = {
  id: string
  threadId: string
}

export type TengriCodexEventKind =
  | 'approval'
  | 'assistant-text'
  | 'error'
  | 'file-diff'
  | 'plan'
  | 'reasoning-summary'
  | 'thread-state'
  | 'tool-call'
  | 'tool-output'
  | 'usage'
  | 'user-message'
  | 'warning'
  | 'unknown'

export type TengriCodexEvent = {
  sequence: number
  kind: TengriCodexEventKind
  method: string
  threadId: string
  turnId: string
  itemId: string
  text: string
  approvalId: string
  rawJson: string
}

export type TengriPreviewSession = {
  id: string
  launchUrl: string
  expiresAt: string
}

export type TengriAction =
  | { action: 'create-agent'; displayName: string }
  | { action: 'delete-agent'; agentId: string }
  | { action: 'sleep-agent'; agentId: string }
  | { action: 'resume-agent'; agentId: string }
  | { action: 'list-files'; agentId: string; path: string }
  | { action: 'read-file'; agentId: string; path: string }
  | { action: 'write-file'; agentId: string; path: string; content: string }
  | { action: 'create-directory'; agentId: string; path: string }
  | { action: 'move-file'; agentId: string; sourcePath: string; destinationPath: string }
  | { action: 'delete-file'; agentId: string; path: string; recursive: boolean }
  | { action: 'search-files'; agentId: string; path: string; query: string }
  | { action: 'list-terminals'; agentId: string }
  | { action: 'create-terminal'; agentId: string; cwd: string; columns: number; rows: number }
  | { action: 'terminate-terminal'; agentId: string; terminalId: string }
  | { action: 'terminal-ticket'; agentId: string; terminalId: string }
  | { action: 'codex-account'; agentId: string }
  | { action: 'codex-login'; agentId: string }
  | { action: 'create-thread'; agentId: string }
  | { action: 'resume-thread'; agentId: string; threadId: string }
  | { action: 'send-turn'; agentId: string; threadId: string; text: string }
  | { action: 'steer-turn'; agentId: string; threadId: string; turnId: string; text: string }
  | { action: 'interrupt-turn'; agentId: string; threadId: string; turnId: string }
  | {
      action: 'resolve-approval'
      agentId: string
      approvalId: string
      decision: 'approve-once' | 'approve-session' | 'deny'
    }
  | { action: 'preview-session'; agentId: string; port: number; path: string }
