export type MissionStatus = 'running' | 'pending' | 'completed' | 'failed'

export interface Mission {
  id: string
  title: string
  summary: string
  repo: string
  owner: string
  tags: string[]
  status: MissionStatus
  progress: number
  updatedAt: string
  eta?: string
}

export interface TimelineItem {
  id: string
  at: string
  actor: string
  label: string
  note?: string
  kind: 'message' | 'action' | 'error'
}

export interface LogEntry {
  id: string
  at: string
  level: 'info' | 'warn' | 'error'
  message: string
}

export interface MissionDetail extends Mission {
  timeline: TimelineItem[]
  logs: LogEntry[]
  pr: {
    title: string
    branch: string
    status: 'draft' | 'pending-review' | 'merged' | 'blocked'
    url?: string
    reviewer?: string
  }
}
