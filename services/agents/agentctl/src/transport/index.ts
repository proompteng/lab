import type * as grpc from '@grpc/grpc-js'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { AgentctlContext } from '../cli/context'
import { asAgentctlError } from '../cli/errors'
import { createKubectlBackend, type KubeBackend } from '../kube/backend'
import { createClient, createMetadata } from '../legacy'

export type KubeTransport = {
  mode: 'kube'
  backend: KubeBackend
}

export type GrpcTransport = {
  mode: 'grpc'
  client: grpc.Client
  metadata: grpc.Metadata
}

export type Transport = KubeTransport | GrpcTransport

export class TransportService extends Context.Tag('agentctl/Transport')<TransportService, Transport>() {}

export const TransportLive = Layer.effect(
  TransportService,
  Effect.gen(function* () {
    const { resolved } = yield* AgentctlContext
    if (resolved.mode === 'kube') {
      const backend = yield* Effect.try({
        try: () =>
          createKubectlBackend({
            kubeconfig: resolved.kubeconfig,
            context: resolved.context,
          }),
        catch: (error) => asAgentctlError(error, 'KubeError'),
      })
      return { mode: 'kube', backend }
    }

    const client = yield* Effect.tryPromise({
      try: () => createClient(resolved.address, resolved.tls),
      catch: (error) => asAgentctlError(error, 'GrpcError'),
    })
    const metadata = createMetadata(resolved.token)
    return { mode: 'grpc', client, metadata }
  }),
)
