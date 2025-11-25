export type Nullable<T> = T | null

export type ChatRole = 'user' | 'assistant' | 'system'

export interface ChatSession {
  id: string
  userId: string
  title: string
  lastMessageAt: number
  createdAt: number
  updatedAt: number
  deletedAt: Nullable<number>
}

export interface ChatMessage {
  id: string
  sessionId: string
  role: ChatRole
  content: string
  metadata?: unknown
  createdAt: number
  updatedAt: number
  deletedAt: Nullable<number>
}

export type WorkOrderStatus = 'draft' | 'submitted' | 'accepted' | 'running' | 'succeeded' | 'failed' | 'canceled'

export interface WorkOrder {
  id: string
  sessionId: string
  workflowId: string
  githubIssueUrl?: string
  prompt?: string
  title?: string
  status: WorkOrderStatus
  requestedBy?: string
  targetRepo?: string
  targetBranch?: string
  prUrl?: string
  createdAt: number
  updatedAt: number
  deletedAt: Nullable<number>
}

export interface CreateWorkOrderInput {
  sessionId: string
  workflowId: string
  githubIssueUrl?: string
  prompt?: string
  title?: string
  status?: WorkOrderStatus
  requestedBy?: string
  targetRepo?: string
  targetBranch?: string
  prUrl?: string
}

export interface AppendMessageInput {
  sessionId: string
  role: ChatRole
  content: string
  metadata?: unknown
}
