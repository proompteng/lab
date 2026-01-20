import type { ReactNode } from 'react'

import type { PrimitiveEventItem } from '@/data/agents-control-plane'

import { cn } from '@/lib/utils'

type ConditionEntry = {
  type: string | null
  status: string | null
  reason: string | null
  message: string | null
  lastTransitionTime: string | null
}

export type StatusCategory = 'Ready' | 'Running' | 'Failed' | 'Unknown'

const readString = (value: unknown) => {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toString()
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }
  return null
}

const readRecord = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value)

const needsYamlQuotes = (value: string) =>
  value.length === 0 ||
  value.startsWith(' ') ||
  value.endsWith(' ') ||
  value.includes('\n') ||
  value.includes(':') ||
  value.includes('#') ||
  value.includes('{') ||
  value.includes('}') ||
  value.includes('[') ||
  value.includes(']') ||
  value.includes(',') ||
  value.includes('"') ||
  value.includes("'")

const formatYamlScalar = (value: unknown): string => {
  if (value == null) return 'null'
  if (typeof value === 'string') {
    return needsYamlQuotes(value) ? JSON.stringify(value) : value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return JSON.stringify(value)
    return `${value}`
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return JSON.stringify(value)
}

const stringifyYaml = (value: unknown, indent = 0): string => {
  const indentText = ' '.repeat(indent)
  if (Array.isArray(value)) {
    if (value.length === 0) return `${indentText}[]`
    return value
      .map((entry) => {
        const entryIsObject = isPlainObject(entry) || Array.isArray(entry)
        const prefix = `${indentText}- `
        if (!entryIsObject) {
          return `${prefix}${formatYamlScalar(entry)}`
        }
        const nested = stringifyYaml(entry, indent + 2)
        return `${prefix}${nested.trimStart()}`
      })
      .join('\n')
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value)
    if (entries.length === 0) return `${indentText}{}`
    return entries
      .map(([key, entry]) => {
        const safeKey = needsYamlQuotes(key) ? JSON.stringify(key) : key
        const entryIsObject = isPlainObject(entry) || Array.isArray(entry)
        if (!entryIsObject) {
          return `${indentText}${safeKey}: ${formatYamlScalar(entry)}`
        }
        const nested = stringifyYaml(entry, indent + 2)
        return `${indentText}${safeKey}:\n${nested}`
      })
      .join('\n')
  }

  return `${indentText}${formatYamlScalar(value)}`
}

export const getMetadataValue = (resource: Record<string, unknown>, key: string) => {
  const metadata = readRecord(resource.metadata) ?? {}
  return readString(metadata[key])
}

const getLatestManagedFieldTime = (resource: Record<string, unknown>) => {
  const metadata = readRecord(resource.metadata) ?? {}
  const managedFields = Array.isArray(metadata.managedFields) ? metadata.managedFields : []
  let latest: string | null = null
  let latestTimestamp = Number.NEGATIVE_INFINITY

  for (const entry of managedFields) {
    if (!entry || typeof entry !== 'object') continue
    const time = readString((entry as Record<string, unknown>).time)
    if (!time) continue
    const parsed = Date.parse(time)
    if (!Number.isFinite(parsed)) {
      if (!latest) {
        latest = time
      }
      continue
    }
    if (parsed > latestTimestamp) {
      latest = time
      latestTimestamp = parsed
    }
  }

  return latest
}

export const getResourceCreatedAt = (resource: Record<string, unknown>) =>
  getMetadataValue(resource, 'creationTimestamp')

export const getResourceUpdatedAt = (resource: Record<string, unknown>) =>
  readNestedValue(resource, ['status', 'updatedAt']) ??
  readNestedValue(resource, ['status', 'lastUpdatedAt']) ??
  readNestedValue(resource, ['status', 'lastSyncedAt']) ??
  readNestedValue(resource, ['status', 'syncedAt']) ??
  readNestedValue(resource, ['status', 'completedAt']) ??
  readNestedValue(resource, ['status', 'startedAt']) ??
  readNestedValue(resource, ['metadata', 'annotations', 'agents.proompteng.ai/updatedAt']) ??
  getLatestManagedFieldTime(resource) ??
  getMetadataValue(resource, 'creationTimestamp')

export const getSpecValue = (resource: Record<string, unknown>, key: string) => {
  const spec = readRecord(resource.spec) ?? {}
  return readString(spec[key])
}

export const getStatusValue = (resource: Record<string, unknown>, key: string) => {
  const status = readRecord(resource.status) ?? {}
  return readString(status[key])
}

export const readNestedValue = (resource: Record<string, unknown>, path: string[]) => {
  let cursor: unknown = resource
  for (const key of path) {
    const record = readRecord(cursor)
    if (!record) return null
    cursor = record[key]
  }
  return readString(cursor)
}

export const readNestedArrayValue = (resource: Record<string, unknown>, path: string[]) => {
  let cursor: unknown = resource
  for (const key of path) {
    const record = readRecord(cursor)
    if (!record) return null
    cursor = record[key]
  }
  if (!Array.isArray(cursor)) return null
  const values = cursor.map((entry) => readString(entry)).filter((entry): entry is string => Boolean(entry))
  return values.length > 0 ? values.join(', ') : null
}

export const getStatusConditions = (resource: Record<string, unknown>): ConditionEntry[] => {
  const status = readRecord(resource.status) ?? {}
  const rawConditions = Array.isArray(status.conditions) ? status.conditions : []
  return rawConditions
    .map((entry) => (entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => ({
      type: readString(entry.type),
      status: readString(entry.status),
      reason: readString(entry.reason),
      message: readString(entry.message),
      lastTransitionTime: readString(entry.lastTransitionTime),
    }))
}

export const formatTimestamp = (value: string | null) => {
  if (!value) return '—'
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return value
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(parsed))
}

const normalizeStatusLabel = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim()

const statusIncludes = (value: string, checks: string[]) => checks.some((check) => value.includes(check))

const isFailedStatus = (value: string) =>
  statusIncludes(value, ['fail', 'error', 'degrad', 'invalid', 'unhealthy', 'not ready', 'crash', 'terminated'])

const isRunningStatus = (value: string) =>
  statusIncludes(value, ['running', 'progress', 'in progress', 'pending', 'queued', 'starting'])

const isReadyStatus = (value: string) =>
  statusIncludes(value, ['ready', 'succeeded', 'success', 'completed', 'available', 'healthy'])

export const deriveStatusLabel = (resource: Record<string, unknown>) => {
  const status = readRecord(resource.status) ?? {}
  const phase = readString(status.phase) ?? readString(status.state) ?? readString(status.status)
  if (phase) return phase

  const conditions = getStatusConditions(resource)
  const ready = conditions.find((condition) => normalizeStatusLabel(condition.type ?? '') === 'ready')
  if (ready?.status) {
    return ready.status === 'True' ? 'Ready' : 'Not Ready'
  }

  const firstCondition = conditions[0]
  if (firstCondition?.type && firstCondition.status) {
    return `${firstCondition.type}: ${firstCondition.status}`
  }

  return 'Unknown'
}

export const deriveStatusCategory = (resource: Record<string, unknown>): StatusCategory => {
  const status = readRecord(resource.status) ?? {}
  const phase = readString(status.phase) ?? readString(status.state) ?? readString(status.status)
  const normalizedPhase = phase ? normalizeStatusLabel(phase) : null

  const conditions = getStatusConditions(resource)
  const readyCondition = conditions.find((condition) => normalizeStatusLabel(condition.type ?? '') === 'ready')
  if (readyCondition?.status) {
    if (readyCondition.status === 'True') return 'Ready'
    if (readyCondition.status === 'False') return 'Failed'
    if (readyCondition.status === 'Unknown') return 'Unknown'
  }

  if (normalizedPhase) {
    if (isFailedStatus(normalizedPhase)) return 'Failed'
    if (isRunningStatus(normalizedPhase)) return 'Running'
    if (isReadyStatus(normalizedPhase)) return 'Ready'
  }

  const failingCondition = conditions.find((condition) => condition.status === 'False')
  if (failingCondition) return 'Failed'
  const passingCondition = conditions.find((condition) => condition.status === 'True')
  if (passingCondition) return 'Ready'

  return 'Unknown'
}

export const summarizeConditions = (resource: Record<string, unknown>) => {
  const conditions = getStatusConditions(resource)
  if (conditions.length === 0) {
    return { summary: 'No conditions reported', lastTransitionTime: null }
  }

  const labels = conditions.map((condition) => {
    const type = condition.type ?? 'Condition'
    const status = condition.status ?? '—'
    return `${type}: ${status}`
  })

  const summary =
    labels.length > 2 ? `${labels.slice(0, 2).join(' · ')} +${labels.length - 2} more` : labels.join(' · ')

  const lastTransitionTime = conditions.reduce<string | null>((latest, condition) => {
    if (!condition.lastTransitionTime) return latest
    if (!latest) return condition.lastTransitionTime
    const latestTime = Date.parse(latest)
    const nextTime = Date.parse(condition.lastTransitionTime)
    if (!Number.isFinite(latestTime)) return condition.lastTransitionTime
    if (!Number.isFinite(nextTime)) return latest
    return nextTime > latestTime ? condition.lastTransitionTime : latest
  }, null)

  return { summary, lastTransitionTime }
}

const toneForStatus = (value: string) => {
  const normalized = normalizeStatusLabel(value)
  if (
    normalized.includes('fail') ||
    normalized.includes('error') ||
    normalized.includes('invalid') ||
    normalized.includes('degrad') ||
    normalized.includes('unhealthy') ||
    normalized.includes('not ready')
  )
    return 'danger'
  if (normalized.includes('running') || normalized.includes('progress')) return 'accent'
  if (normalized.includes('pending') || normalized.includes('queued')) return 'warning'
  if (normalized.includes('ready') || normalized.includes('succeeded') || normalized.includes('healthy'))
    return 'success'
  return 'muted'
}

export const StatusBadge = ({ label }: { label: string }) => {
  const tone = toneForStatus(label)
  const base = 'inline-flex items-center rounded-none border px-2 py-0.5 text-xs uppercase tracking-wide'
  const classes =
    tone === 'success'
      ? `${base} border-emerald-200 bg-emerald-50 text-emerald-700`
      : tone === 'warning'
        ? `${base} border-amber-200 bg-amber-50 text-amber-700`
        : tone === 'danger'
          ? `${base} border-red-200 bg-red-50 text-red-700`
          : tone === 'accent'
            ? `${base} border-sky-200 bg-sky-50 text-sky-700`
            : `${base} border-border bg-muted text-muted-foreground`

  return <span className={classes}>{label}</span>
}

export const ConditionsList = ({
  conditions,
  emptyLabel = 'No conditions reported.',
}: {
  conditions: ConditionEntry[]
  emptyLabel?: string
}) => {
  if (conditions.length === 0) {
    return <div className="text-xs text-muted-foreground">{emptyLabel}</div>
  }

  return (
    <ul className="space-y-2 text-xs">
      {conditions.map((condition) => (
        <li key={`${condition.type}-${condition.lastTransitionTime ?? 'unknown'}`} className="space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-medium text-foreground">{condition.type ?? 'Unknown'}</div>
            <span className="text-muted-foreground">{condition.status ?? '—'}</span>
          </div>
          {condition.reason ? <div className="text-muted-foreground">{condition.reason}</div> : null}
          {condition.message ? <div className="text-muted-foreground">{condition.message}</div> : null}
          {condition.lastTransitionTime ? (
            <div className="text-muted-foreground">{formatTimestamp(condition.lastTransitionTime)}</div>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

export const EventsList = ({
  events,
  error,
  emptyLabel = 'No recent events.',
}: {
  events: PrimitiveEventItem[]
  error?: string | null
  emptyLabel?: string
}) => {
  if (error) {
    return <div className="text-xs text-destructive">{error}</div>
  }
  if (events.length === 0) {
    return <div className="text-xs text-muted-foreground">{emptyLabel}</div>
  }

  return (
    <ul className="space-y-2 text-xs">
      {events.map((event) => (
        <li key={`${event.name ?? 'event'}-${event.lastTimestamp ?? event.eventTime ?? 'time'}`} className="space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">{event.reason ?? 'Event'}</span>
              {event.type ? (
                <span className="rounded-none border border-border bg-muted px-1.5 py-0.5 text-[10px] uppercase">
                  {event.type}
                </span>
              ) : null}
              {typeof event.count === 'number' && event.count > 1 ? (
                <span className="text-muted-foreground">x{event.count}</span>
              ) : null}
            </div>
            <span className="text-muted-foreground">{formatTimestamp(event.eventTime ?? event.lastTimestamp)}</span>
          </div>
          {event.action ? <div className="text-muted-foreground">Action: {event.action}</div> : null}
          {event.message ? <div className="text-muted-foreground">{event.message}</div> : null}
        </li>
      ))}
    </ul>
  )
}

export const YamlCodeBlock = ({ value, className }: { value: unknown; className?: string }) => {
  const yaml = stringifyYaml(value ?? {})
  return (
    <pre className={cn('overflow-auto rounded-none border p-3 text-xs border-border bg-muted/30', className)}>
      <code className="font-mono">{yaml}</code>
    </pre>
  )
}

export const DescriptionList = ({
  items,
  className,
}: {
  items: Array<{ label: string; value: ReactNode }>
  className?: string
}) => (
  <dl className={cn('grid gap-3 sm:grid-cols-2', className)}>
    {items.map((item) => (
      <div key={item.label} className="space-y-1">
        <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{item.label}</dt>
        <dd className="text-sm text-foreground break-words">{item.value}</dd>
      </div>
    ))}
  </dl>
)
