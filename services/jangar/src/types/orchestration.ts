import type { ThreadItem, Usage } from '@proompteng/codex'

export type OrchestrationStatus = 'pending' | 'running' | 'completed' | 'failed' | 'aborted'

export interface OrchestrationInput {
  topic: string
  repoUrl?: string
  constraints?: string
  depth?: number
  maxTurns?: number
}

export interface TurnSnapshot {
  index: number
  threadId: string | null
  finalResponse: string
  items: ThreadItem[]
  usage: Usage | null
  createdAt: string
}

export interface WorkerTaskResult {
  prUrl?: string
  branch?: string
  commitSha?: string
  notes?: string
}

export interface OrchestrationState {
  id: string
  topic: string
  repoUrl?: string
  status: OrchestrationStatus
  turns: TurnSnapshot[]
  workerPRs: WorkerTaskResult[]
  createdAt: string
  updatedAt: string
}

export interface OrchestrationSignalSubmitMessage {
  message: string
  images?: string[]
}

export interface OrchestrationQueries {
  getState: OrchestrationState
}

export interface OrchestrationConfig {
  depthLimit: number
  maxTurns: number
}

// TODO(jng-020a): Replace placeholders once Drizzle schema is implemented.
