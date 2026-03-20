type ArgoApplication = {
  status?: {
    health?: {
      status?: string
    }
    history?: Array<{
      revision?: string
    }>
    operationState?: {
      phase?: string
      syncResult?: {
        revision?: string
      }
    }
    sync?: {
      revision?: string
      status?: string
    }
  }
}

export type ArgoApplicationStatus = {
  syncStatus: string
  healthStatus: string
  desiredRevision: string
  deployedRevision: string
  revision: string
}

const unknownValue = 'unknown'

const normalizeString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const resolveLatestHistoryRevision = (history: ArgoApplication['status'] extends { history?: infer H } ? H : never) => {
  if (!Array.isArray(history)) {
    return undefined
  }

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const revision = normalizeString(history[index]?.revision)
    if (revision) {
      return revision
    }
  }

  return undefined
}

export const resolveArgoApplicationStatus = (application: ArgoApplication): ArgoApplicationStatus => {
  const syncStatus = normalizeString(application.status?.sync?.status) ?? unknownValue
  const healthStatus = normalizeString(application.status?.health?.status) ?? unknownValue
  const desiredRevision = normalizeString(application.status?.sync?.revision) ?? unknownValue
  const syncResultRevision =
    normalizeString(application.status?.operationState?.phase) === 'Succeeded'
      ? normalizeString(application.status?.operationState?.syncResult?.revision)
      : undefined
  const historyRevision = resolveLatestHistoryRevision(application.status?.history)
  const deployedRevision = syncResultRevision ?? historyRevision ?? desiredRevision

  return {
    syncStatus,
    healthStatus,
    desiredRevision,
    deployedRevision,
    revision: deployedRevision,
  }
}

export const parseArgoApplicationStatus = (source: string): ArgoApplicationStatus => {
  const application = JSON.parse(source) as ArgoApplication
  return resolveArgoApplicationStatus(application)
}
