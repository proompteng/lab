import type { ThreadEvent, ThreadItem, Usage } from '@proompteng/codex'

export interface RunCodexTurnInput {
  threadId?: string | null
  prompt: string
  images?: string[]
  depth?: number
  repoUrl?: string
  workdir?: string
  userMessages?: string[]
  constraints?: string
}

export interface RunCodexTurnResult {
  threadId: string | null
  finalResponse: string
  items: ThreadItem[]
  usage: Usage | null
  events: ThreadEvent[]
  createdAt: string
}

export interface WorkerTaskInput {
  repoUrl: string
  task: string
  depth?: number
  baseBranch?: string
  tests?: string
  lint?: string
}

export interface WorkerTaskResult {
  prUrl?: string
  branch?: string
  commitSha?: string
  notes?: string
}

export interface PublishEventInput {
  orchestrationId: string
  payload: unknown
}

// TODO(jng-030a): Validate shapes align with DB schema and workflow state contracts.
