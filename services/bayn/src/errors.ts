import { Data } from 'effect'

export type Component = 'config' | 'database' | 'http' | 'market-data' | 'strategy' | 'journal'

export class OperationalError extends Data.TaggedError('OperationalError')<{
  readonly component: Component
  readonly operation: string
  readonly message: string
  readonly retryable: boolean
  readonly cause?: unknown
}> {}

const causeMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

export const operationalError = (
  component: Component,
  operation: string,
  message: string,
  cause?: unknown,
): OperationalError =>
  new OperationalError({
    component,
    operation,
    message: cause === undefined ? message : `${message}: ${causeMessage(cause)}`,
    retryable: false,
    cause,
  })

export const retryableOperationalError = (
  component: Component,
  operation: string,
  message: string,
  cause?: unknown,
): OperationalError =>
  new OperationalError({
    component,
    operation,
    message: cause === undefined ? message : `${message}: ${causeMessage(cause)}`,
    retryable: true,
    cause,
  })

export const formatError = (error: OperationalError): string =>
  `${error.component}.${error.operation}: ${error.message}`
