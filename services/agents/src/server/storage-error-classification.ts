export type StorageFailureCauseCode = 'missing-config' | 'transient-db' | 'unknown'

export type StorageFailureClassification = {
  readonly causeCode: StorageFailureCauseCode
  readonly retryable: boolean
  readonly httpStatusCode: 500 | 503
}

export type ClassifiedStorageFailure = StorageFailureClassification & {
  readonly message: string
}

export const toErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const classifyStorageErrorMessage = (message: string): StorageFailureClassification => {
  const normalized = message.toLowerCase()
  if (normalized.includes('database_url')) {
    return { causeCode: 'missing-config', retryable: false, httpStatusCode: 503 }
  }
  if (
    normalized.includes('econnrefused') ||
    normalized.includes('connection terminated unexpectedly') ||
    normalized.includes('server closed the connection unexpectedly') ||
    normalized.includes('connection reset by peer') ||
    normalized.includes('timeout') ||
    normalized.includes('timed out')
  ) {
    return { causeCode: 'transient-db', retryable: true, httpStatusCode: 503 }
  }
  return { causeCode: 'unknown', retryable: false, httpStatusCode: 500 }
}

export const classifyStorageFailure = (error: unknown): ClassifiedStorageFailure => {
  const message = toErrorMessage(error)
  return { message, ...classifyStorageErrorMessage(message) }
}
