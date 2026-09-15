export type MarketContextFailureCategory =
  | 'provider_circuit_open'
  | 'provider_capacity_exhausted'
  | 'provider_bootstrap_failure'
  | 'provider_attempt_timeout'
  | 'provider_turn_failed'
  | 'payload_validation_failure'
  | 'finalize_callback_failure'
  | 'attempt_budget_exhausted'
  | 'unknown_failure'

const parseNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const parseFailureCategory = (value: unknown): MarketContextFailureCategory | null => {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (
    normalized === 'provider_circuit_open' ||
    normalized === 'provider_capacity_exhausted' ||
    normalized === 'provider_bootstrap_failure' ||
    normalized === 'provider_attempt_timeout' ||
    normalized === 'provider_turn_failed' ||
    normalized === 'payload_validation_failure' ||
    normalized === 'finalize_callback_failure' ||
    normalized === 'attempt_budget_exhausted' ||
    normalized === 'unknown_failure'
  ) {
    return normalized
  }
  return null
}

export const PROVIDER_CAPACITY_ERROR_TOKENS = [
  'provider_capacity_exhausted',
  'usage limit',
  'quota',
  'insufficient_quota',
  'model unavailable',
  'model is not supported',
  'not supported when using codex',
]

export const isProviderCapacityMessage = (value: unknown): boolean => {
  if (typeof value !== 'string') return false
  const normalized = value.toLowerCase()
  return PROVIDER_CAPACITY_ERROR_TOKENS.some((token) => normalized.includes(token))
}

const isProviderCapacityAttempt = (attempt: unknown): boolean => {
  if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) return false
  const row = attempt as Record<string, unknown>
  const failureCategory = typeof row.failureCategory === 'string' ? row.failureCategory.trim() : ''
  if (failureCategory === 'provider_fallback_eligible') return true
  return isProviderCapacityMessage(row.error)
}

export const resolveFailureCategoryFromMetadata = (
  metadata: Record<string, unknown>,
): MarketContextFailureCategory | null => {
  const direct = parseFailureCategory(metadata.failureCategory)
  if (direct && direct !== 'attempt_budget_exhausted') return direct
  const attempts = Array.isArray(metadata.providerAttempts) ? metadata.providerAttempts : []
  let providerCapacityAttemptCount = 0
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index]
    if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) continue
    if (isProviderCapacityAttempt(attempt)) {
      providerCapacityAttemptCount += 1
      continue
    }
    const category = parseFailureCategory((attempt as Record<string, unknown>).failureCategory)
    if (category) return category
  }
  if (
    providerCapacityAttemptCount > 0 &&
    (direct === 'attempt_budget_exhausted' || providerCapacityAttemptCount === attempts.length)
  ) {
    return 'provider_capacity_exhausted'
  }
  if (direct) return direct
  return null
}

export const resolveFailureSignal = (params: {
  metadata: Record<string, unknown>
  message?: string | null
  error?: string | null
}): { category: MarketContextFailureCategory | null; error: string | null; message: string | null } => {
  const category = resolveFailureCategoryFromMetadata(params.metadata)
  const message = parseNonEmptyString(params.message ?? params.error)
  return {
    category,
    error: category ?? message,
    message,
  }
}
