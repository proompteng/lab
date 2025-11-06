import { Effect } from 'effect'
import type { Interceptor } from '@connectrpc/connect'

export type TemporalInterceptor = Interceptor

export interface InterceptorBuilderInput {
  readonly namespace: string
  readonly identity: string
}

export interface InterceptorBuilder {
  readonly build: (input: InterceptorBuilderInput) => Effect.Effect<TemporalInterceptor[], unknown, never>
}

export const makeDefaultInterceptorBuilder = (): InterceptorBuilder => ({
  build(input) {
    // TODO(TBS-005): Provide logging, metrics, and retry aware interceptors.
    void input
    return Effect.succeed([])
  },
})
