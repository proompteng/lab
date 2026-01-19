import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

type ConditionEntry = {
  type: string | null
  status: string | null
  reason: string | null
  message: string | null
  lastTransitionTime: string | null
}

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

export const getMetadataValue = (resource: Record<string, unknown>, key: string) => {
  const metadata = readRecord(resource.metadata) ?? {}
  return readString(metadata[key])
}

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

const toneForStatus = (value: string) => {
  const normalized = normalizeStatusLabel(value)
  if (normalized.includes('fail') || normalized.includes('error') || normalized.includes('invalid')) return 'danger'
  if (normalized.includes('running') || normalized.includes('in progress')) return 'accent'
  if (normalized.includes('pending') || normalized.includes('queued')) return 'warning'
  if (normalized.includes('ready') || normalized.includes('succeeded')) return 'success'
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
