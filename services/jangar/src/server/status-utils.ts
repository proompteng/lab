import { asRecord, asString } from '~/server/primitives-http'

type ConditionForCompare = {
  type: string | null
  status: string | null
  reason: string | null
  message: string | null
}

const normalizeCondition = (value: Record<string, unknown>): ConditionForCompare => ({
  type: asString(value.type),
  status: asString(value.status),
  reason: asString(value.reason),
  message: asString(value.message),
})

const normalizeConditionsForCompare = (raw: unknown): ConditionForCompare[] | undefined => {
  if (!Array.isArray(raw)) return undefined
  const normalized = raw
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map(normalizeCondition)
    .filter((entry) => entry.type || entry.status || entry.reason || entry.message)
  if (normalized.length === 0) return undefined
  normalized.sort((a, b) => {
    const typeCompare = (a.type ?? '').localeCompare(b.type ?? '')
    if (typeCompare !== 0) return typeCompare
    const statusCompare = (a.status ?? '').localeCompare(b.status ?? '')
    if (statusCompare !== 0) return statusCompare
    const reasonCompare = (a.reason ?? '').localeCompare(b.reason ?? '')
    if (reasonCompare !== 0) return reasonCompare
    return (a.message ?? '').localeCompare(b.message ?? '')
  })
  return normalized
}

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

export const normalizeStatusForCompare = (status: Record<string, unknown> | null | undefined) => {
  const record = asRecord(status) ?? {}
  const next: Record<string, unknown> = { ...record }
  delete next.updatedAt
  const normalizedConditions = normalizeConditionsForCompare(record.conditions)
  if (normalizedConditions) {
    next.conditions = normalizedConditions
  } else {
    delete next.conditions
  }
  return next
}

const normalizeMetadataForCompare = (metadata: Record<string, unknown> | null | undefined) => {
  const record = asRecord(metadata) ?? {}
  const next: Record<string, unknown> = { ...record }
  delete next.resourceVersion
  delete next.managedFields
  return next
}

export const shouldApplyStatus = (
  currentStatus: Record<string, unknown> | null | undefined,
  nextStatus: Record<string, unknown>,
) => {
  const normalizedCurrent = normalizeStatusForCompare(currentStatus)
  const normalizedNext = normalizeStatusForCompare(nextStatus)
  return stableStringify(normalizedCurrent) !== stableStringify(normalizedNext)
}

export const buildResourceFingerprint = (summary: Record<string, unknown>) => {
  const metadata = asRecord(summary.metadata)
  const spec = asRecord(summary.spec) ?? {}
  const status = asRecord(summary.status)
  return stableStringify({
    apiVersion: asString(summary.apiVersion),
    kind: asString(summary.kind),
    metadata: normalizeMetadataForCompare(metadata),
    spec,
    status: normalizeStatusForCompare(status),
  })
}
