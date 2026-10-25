import type { TengriCodexOptions } from './codex-models'
import type { TengriPowerSettings } from './schemas'

export type AgentPhase = 'booting' | 'failed' | 'pending' | 'ready' | 'sleeping' | 'terminating' | 'unknown'
export type AgentArchitecture = 'amd64' | 'arm64' | 'unknown'
export type TengriErrorCode =
  | 'conversation_not_found'
  | 'control_not_dispatched'
  | 'conversation_history_invalid'
  | 'file_conflict'
  | 'capacity_full'
  | 'lifecycle_superseded'
  | 'model_catalog_invalid'

export type TengriCondition = {
  type: string
  status: string
  reason: string
  message: string
  lastTransitionAt: string
}

export type TengriAgent = {
  id: string
  uid: string
  runtimeEpoch: string
  policyVersion: string
  displayName: string
  phase: AgentPhase
  architecture: AgentArchitecture
  cpuMillis: number
  memoryMib: number
  workspaceGib: number
  power: TengriPowerSettings
  nodeName: string
  message: string
  createdAt: string
  readyAt: string
  lastActivityAt: string
  idleDeadline: string
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

export type TengriFileList = {
  path: string
  entries: TengriFileEntry[]
}

export type TengriFileSearchResult = {
  entries: TengriFileEntry[]
  truncated: boolean
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
  creationId: string
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
  eventSequence: number
  itemEventSequences?: Record<string, number>
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
  previewOrigin: string
}

export type TengriAction =
  | { action: 'create-agent'; displayName: string }
  | { action: 'delete-agent'; agentId: string; workspaceUid: string }
  | { action: 'sleep-agent'; agentId: string; workspaceUid: string }
  | { action: 'resume-agent'; agentId: string; workspaceUid: string }
  | { action: 'update-power-settings'; agentId: string; power: TengriPowerSettings }
  | { action: 'stat-file'; agentId: string; path: string }
  | { action: 'list-files'; agentId: string; path: string }
  | { action: 'read-file'; agentId: string; path: string }
  | { action: 'write-file'; agentId: string; path: string; content: string; expectedRevision: string }
  | { action: 'create-directory'; agentId: string; path: string }
  | { action: 'move-file'; agentId: string; sourcePath: string; destinationPath: string }
  | { action: 'delete-file'; agentId: string; path: string; recursive: boolean }
  | { action: 'search-files'; agentId: string; path: string; query: string }
  | { action: 'list-terminals'; agentId: string }
  | { action: 'create-terminal'; agentId: string; creationId: string; cwd: string; columns: number; rows: number }
  | { action: 'terminate-terminal'; agentId: string; terminalId: string }
  | { action: 'terminal-ticket'; agentId: string; terminalId: string }
  | { action: 'codex-account'; agentId: string }
  | { action: 'codex-login-status'; agentId: string }
  | { action: 'codex-login'; agentId: string }
  | { action: 'codex-models'; agentId: string; cursor?: string }
  | { action: 'active-codex-run'; agentId: string }
  | { action: 'codex-run'; agentId: string; runId: string }
  | { action: 'list-threads'; agentId: string; archived: boolean; cursor?: string }
  | { action: 'set-thread-archived'; agentId: string; threadId: string; archived: boolean }
  | ({ action: 'create-thread'; agentId: string } & TengriCodexOptions)
  | ({ action: 'resume-thread'; agentId: string; threadId: string } & TengriCodexOptions)
  | ({
      action: 'send-turn'
      agentId: string
      operationId: string
      threadId: string
      text: string
      images: import('./codex-images').TengriCodexImage[]
    } & TengriCodexOptions)
  | {
      action: 'steer-turn'
      runId: string
      agentId: string
      operationId: string
      threadId: string
      turnId: string
      text: string
      images: import('./codex-images').TengriCodexImage[]
    }
  | {
      action: 'answer-questions'
      runId: string
      operationId: string
      agentId: string
      approvalId: string
      response: import('./codex-input').TengriCodexInputResponse
    }
  | { action: 'interrupt-turn'; runId: string; operationId: string; agentId: string }
  | {
      action: 'resolve-approval'
      runId: string
      operationId: string
      agentId: string
      approvalId: string
      decision:
        | 'approve-once'
        | 'approve-session'
        | 'approve-exec-policy-amendment'
        | 'approve-network-policy-amendment'
        | 'deny'
    }
  | { action: 'preview-session'; agentId: string; port: number; path: string; fragment: string }
  | { action: 'editor-session'; agentId: string; windowId: string; renewal: boolean }
  | { action: 'browser-session'; agentId: string; windowId: string; renewal: boolean }
  | { action: 'revoke-editor-sessions' }
  | { action: 'revoke-preview-session'; agentId: string; sessionId: string; revocationToken: string }
