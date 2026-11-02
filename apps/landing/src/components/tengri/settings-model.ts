import type { TengriAgent } from '@/lib/tengri/types'

const PLACEHOLDER = '—'

export type DesktopLifecycleAction = 'delete-agent' | 'sleep-agent'

export async function commitDesktopLifecycleAction({
  action,
  onCommitted,
  request,
}: {
  action: DesktopLifecycleAction
  onCommitted: (action: DesktopLifecycleAction) => void
  request: () => Promise<unknown>
}): Promise<void> {
  await request()
  onCommitted(action)
}

export function shouldRefreshCodexAccount({
  active,
  documentVisible,
}: {
  active: boolean
  documentVisible: boolean
}): boolean {
  return active && documentVisible
}

export function selectSleepRequestError(localError: string, connectionWarning: string): string {
  return localError || connectionWarning
}

export function formatAgentDate(value: string, hydrated: boolean): string {
  if (!hydrated || !value) return PLACEHOLDER
  const date = new Date(value)
  if (!Number.isFinite(date.valueOf())) return PLACEHOLDER
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function formatAgentUptime(agent: TengriAgent, now: number | null): string {
  if (now === null || agent.phase !== 'ready') return PLACEHOLDER
  const startedAt = new Date(agent.readyAt || agent.createdAt).valueOf()
  if (!Number.isFinite(startedAt)) return PLACEHOLDER

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
  if (!Number.isFinite(value)) return PLACEHOLDER
  return String(Math.round(value * 100) / 100)
}
