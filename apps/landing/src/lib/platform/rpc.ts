import 'server-only'

import path from 'node:path'
import * as grpc from '@grpc/grpc-js'
import {
  create,
  fromBinary,
  toBinary,
  type DescMessage,
  type DescMethodUnary,
  type MessageInitShape,
  type MessageShape,
} from '@bufbuild/protobuf'
import { SpiffeSource, verifySpiffePeer } from '../tengri/spiffe'

export function attestedCaller(configuration: () => { target: string; peer: string }) {
  let source: SpiffeSource | undefined
  let settings: string | undefined
  let client: grpc.Client | undefined
  let fingerprint: string | undefined
  async function connection() {
    const { target, peer } = configuration()
    const endpoint = process.env.SPIFFE_ENDPOINT_SOCKET?.trim()
    const identity = process.env.SPIFFE_ID?.trim()
    if (!target || !endpoint || !identity) throw new Error('Platform workload identity is unavailable')
    const next = JSON.stringify([target, peer, endpoint, identity])
    if (!source || settings !== next) {
      client?.close()
      client = undefined
      source?.close()
      source = new SpiffeSource({
        endpoint,
        spiffeId: identity,
        protoPath:
          process.env.SPIFFE_WORKLOAD_API_PROTO_PATH?.trim() ??
          path.resolve(process.cwd(), '../../services/tengri/proto/spiffe/workloadapi.proto'),
      })
      settings = next
    }
    const material = await source.material()
    if (client && fingerprint === material.fingerprint) return client
    const credentials = grpc.credentials.createSsl(material.bundle, material.privateKey, material.certificate, {
      checkServerIdentity: (_hostname, certificate) => verifySpiffePeer(peer, certificate),
    })
    client = new grpc.Client(target, credentials, {
      'grpc.max_receive_message_length': 1_114_112,
      'grpc.max_send_message_length': 262_144,
    })
    const current = client
    setTimeout(() => current.close(), Math.max(0, material.expiresAt - Date.now())).unref()
    fingerprint = material.fingerprint
    return current
  }
  return async function call<I extends DescMessage, O extends DescMessage>(
    method: DescMethodUnary<I, O>,
    input: MessageInitShape<I>,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ): Promise<MessageShape<O>> {
    const client = await connection()
    const metadata = new grpc.Metadata()
    const { injectTrace } = await import('@/lib/observability/server')
    injectTrace((key, value) => metadata.set(key, value))
    metadata.set('x-ofz-contract-version', '1')
    return new Promise((resolve, reject) => {
      const call = client.makeUnaryRequest(
        `/${method.parent.typeName}/${method.name}`,
        (value) => Buffer.from(toBinary(method.input, value)),
        (value) => fromBinary(method.output, value),
        create(method.input, input),
        metadata,
        { deadline: Date.now() + timeoutMs },
        (error, value) => {
          signal?.removeEventListener('abort', cancel)
          if (error) reject(error)
          else if (value) resolve(value)
          else reject(new Error('Platform response is missing'))
        },
      )
      function cancel() {
        call.cancel()
      }
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) cancel()
    })
  }
}
