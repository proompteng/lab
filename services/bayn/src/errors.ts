import { Data } from 'effect'

export class ConfigurationError extends Data.TaggedError('ConfigurationError')<{
  readonly message: string
}> {}

export class DependencyUnavailableError extends Data.TaggedError('DependencyUnavailableError')<{
  readonly dependency: string
  readonly message: string
}> {}

export class ServerStartError extends Data.TaggedError('ServerStartError')<{
  readonly hostname: string
  readonly port: number
  readonly message: string
}> {}

export class ServerStopError extends Data.TaggedError('ServerStopError')<{
  readonly message: string
}> {}
