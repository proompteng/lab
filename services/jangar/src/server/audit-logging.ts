export type AuditRepositoryContext = {
  repository: string | null
  repoOwner: string | null
  repoName: string | null
}

export type AuditEventContext = {
  source?: string | null
  actor?: string | null
  correlationId?: string | null
  requestId?: string | null
  deliveryId?: string | null
  namespace?: string | null
} & Partial<AuditRepositoryContext>

const normalizeHeaderValue = (value: string | null) => {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : null
}

export const resolveActorFromRequest = (request: Request) => {
  const candidates = [
    'x-jangar-actor',
    'x-forwarded-user',
    'x-forwarded-email',
    'x-auth-request-email',
    'x-auth-request-user',
    'x-remote-user',
    'x-github-user',
  ]
  for (const header of candidates) {
    const value = normalizeHeaderValue(request.headers.get(header))
    if (value) return value
  }
  return null
}

export const resolveRequestIdFromRequest = (request: Request) =>
  normalizeHeaderValue(request.headers.get('x-request-id'))

export const resolveCorrelationIdFromRequest = (request: Request) => {
  const candidates = ['x-correlation-id', 'x-request-id', 'x-amzn-trace-id']
  for (const header of candidates) {
    const value = normalizeHeaderValue(request.headers.get(header))
    if (value) return value
  }
  return null
}

export const resolveRepositoryContext = (repository: string | null | undefined): AuditRepositoryContext => {
  const normalized = repository?.trim() ? repository.trim() : null
  if (!normalized) {
    return { repository: null, repoOwner: null, repoName: null }
  }
  const [owner, name] = normalized.split('/', 2)
  return {
    repository: normalized,
    repoOwner: owner?.trim() ? owner.trim() : null,
    repoName: name?.trim() ? name.trim() : null,
  }
}

export const resolveRepositoryFromParameters = (params: Record<string, string> | undefined) => {
  if (!params) return null
  const candidates = [params.repository, params.repo, params.issueRepository]
  for (const candidate of candidates) {
    const trimmed = candidate?.trim() ?? ''
    if (trimmed.length > 0) return trimmed
  }
  return null
}

export const resolveAuditContextFromRequest = (
  request: Request,
  input: { deliveryId?: string | null; namespace?: string | null; repository?: string | null; source?: string | null },
): AuditEventContext => {
  const actor = resolveActorFromRequest(request)
  const requestId = resolveRequestIdFromRequest(request)
  const correlationId = resolveCorrelationIdFromRequest(request) ?? input.deliveryId ?? null
  const repoContext = resolveRepositoryContext(input.repository ?? null)
  return {
    source: input.source ?? null,
    actor,
    correlationId,
    requestId,
    deliveryId: input.deliveryId ?? null,
    namespace: input.namespace ?? null,
    ...repoContext,
  }
}

export const buildAuditPayload = (input: { context?: AuditEventContext; details?: Record<string, unknown> }) => {
  const context = input.context ?? {}
  const repoContext = resolveRepositoryContext(context.repository)
  return {
    source: context.source ?? null,
    actor: context.actor ?? null,
    correlationId: context.correlationId ?? null,
    requestId: context.requestId ?? null,
    deliveryId: context.deliveryId ?? null,
    namespace: context.namespace ?? null,
    repository: repoContext.repository,
    repoOwner: repoContext.repoOwner,
    repoName: repoContext.repoName,
    details: input.details ?? {},
  }
}
