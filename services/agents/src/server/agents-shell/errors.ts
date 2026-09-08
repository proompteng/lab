import { Data } from 'effect'

export class AgentsShellRuntimeError extends Data.TaggedError('AgentsShellRuntimeError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export type AgentsShellError = AgentsShellRuntimeError

export const agentsShellErrorFromUnknown = (error: unknown) =>
  error instanceof AgentsShellRuntimeError
    ? error
    : new AgentsShellRuntimeError({
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      })

export const errorMessage = (error: unknown) =>
  error instanceof AgentsShellRuntimeError ? error.message : error instanceof Error ? error.message : String(error)
