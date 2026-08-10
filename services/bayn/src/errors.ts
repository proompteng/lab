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

export interface OperationalErrorInput {
  readonly component: Component
  readonly operation: string
  readonly message: string
  readonly cause?: unknown
}

const makeOperationalError = (input: OperationalErrorInput, retryable: boolean): OperationalError =>
  new OperationalError({
    component: input.component,
    operation: input.operation,
    message: input.cause === undefined ? input.message : `${input.message}: ${causeMessage(input.cause)}`,
    retryable,
    cause: input.cause,
  })

export const operationalError = (input: OperationalErrorInput): OperationalError => makeOperationalError(input, false)

export const retryableOperationalError = (input: OperationalErrorInput): OperationalError =>
  makeOperationalError(input, true)

export const formatError = (error: OperationalError): string =>
  `${error.component}.${error.operation}: ${error.message}`
