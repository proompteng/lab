import { Data } from 'effect'

export class PublicationError extends Data.TaggedError('PublicationError')<{
  readonly phase: 'arguments' | 'provider' | 'validation' | 'storage' | 'finalization'
  readonly message: string
  readonly cause?: unknown
}> {}

export const publicationError = (
  phase: PublicationError['phase'],
  message: string,
  cause?: unknown,
): PublicationError =>
  new PublicationError({
    phase,
    message: cause instanceof Error ? `${message}: ${cause.message}` : message,
    cause,
  })
