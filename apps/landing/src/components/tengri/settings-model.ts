import type { AgentPhase, TengriAgent } from '@/lib/tengri/types'

export type AgentLifecycleAction = 'resume-agent' | 'sleep-agent'

const DATE_PLACEHOLDER = '—'

export function lifecycleActionForPhase(phase: AgentPhase): AgentLifecycleAction | null {
  if (phase === 'ready') return 'sleep-agent'
  if (phase === 'sleeping') return 'resume-agent'
  return null
}

export function formatAgentPhase(phase: AgentPhase): string {
  if (phase === 'unknown') return 'Unknown'
  return `${phase.charAt(0).toUpperCase()}${phase.slice(1)}`
}

export function formatAgentDate(value: string): string {
  if (!value) return DATE_PLACEHOLDER
  const date = new Date(value)
  if (!Number.isFinite(date.valueOf())) return DATE_PLACEHOLDER
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function formatAgentUptime(agent: TengriAgent, now = Date.now()): string {
  if (agent.phase !== 'ready') return DATE_PLACEHOLDER
  const startedAt = new Date(agent.readyAt || agent.createdAt).valueOf()
  if (!Number.isFinite(startedAt)) return DATE_PLACEHOLDER

  const totalMinutes = Math.max(0, Math.floor((now - startedAt) / 60_000))
  const days = Math.floor(totalMinutes / 1_440)
  const hours = Math.floor((totalMinutes % 1_440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export function formatAgentResources(agent: TengriAgent): string {
  return `${formatQuantity(agent.cpuMillis / 1_000)} CPU · ${formatQuantity(agent.memoryMib / 1_024)} GiB RAM`
}

function formatQuantity(value: number): string {
  if (!Number.isFinite(value)) return DATE_PLACEHOLDER
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)
}
