import { asRecord, asString } from '~/server/primitives-http'

type FailureFallback = {
  reason: string
  message: string
}

export const extractJobFailureDetail = (job: Record<string, unknown>, fallback: FailureFallback) => {
  const status = asRecord(job.status) ?? {}
  const conditions = Array.isArray(status.conditions) ? status.conditions : []
  for (let index = conditions.length - 1; index >= 0; index -= 1) {
    const condition = asRecord(conditions[index])
    if (!condition) continue
    if (asString(condition.type) !== 'Failed' || asString(condition.status) !== 'True') continue
    const reason = asString(condition.reason) ?? fallback.reason
    const message = asString(condition.message) ?? asString(condition.reason) ?? fallback.message
    return { reason, message }
  }

  const statusReason = asString(status.reason)
  const statusMessage = asString(status.message)
  if (statusReason || statusMessage) {
    return {
      reason: statusReason ?? fallback.reason,
      message: statusMessage ?? statusReason ?? fallback.message,
    }
  }

  return fallback
}
