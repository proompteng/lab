import { Data } from 'effect'

export type Component = 'config' | 'http' | 'market-data' | 'strategy' | 'journal'

export class OperationalError extends Data.TaggedError('OperationalError')<{
  readonly component: Component
  readonly operation: string
  readonly message: string
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
    cause,
  })

export const formatError = (error: OperationalError): string =>
  `${error.component}.${error.operation}: ${error.message}`
