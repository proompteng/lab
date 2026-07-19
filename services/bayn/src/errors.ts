import { Data } from 'effect'

export type BaynComponent = 'config' | 'http' | 'market-data' | 'strategy' | 'journal'

export class BaynError extends Data.TaggedError('BaynError')<{
  readonly component: BaynComponent
  readonly operation: string
  readonly message: string
}> {}

const causeMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

export const baynError = (component: BaynComponent, operation: string, message: string, cause?: unknown): BaynError =>
  new BaynError({
    component,
    operation,
    message: cause === undefined ? message : `${message}: ${causeMessage(cause)}`,
  })

export const formatBaynError = (error: BaynError): string => `${error.component}.${error.operation}: ${error.message}`
