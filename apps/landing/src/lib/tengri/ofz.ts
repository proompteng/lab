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
import { SpiffeSource, verifySpiffePeer } from './spiffe'

const BFF_ID = 'spiffe://proompteng.ai/ns/proompteng/sa/proompteng'
const OFZ_ID = 'spiffe://proompteng.ai/ns/ofz/sa/ofz-api'
let source: SpiffeSource | undefined
let configuration: string | undefined
let client: grpc.Client | undefined
let fingerprint: string | undefined

export class OfzError extends Error {
  constructor(
    readonly status: number,
    readonly auditReceiptId = '',
    cause?: unknown,
  ) {
    super(
      status === 401
        ? 'Your session expired. Sign in again.'
        : status === 403
          ? 'Ofz denied this request.'
          : status === 409
            ? 'Access changed. Refresh before retrying.'
            : status === 422
              ? 'This change is blocked by an access or quota constraint.'
              : status === 400
                ? 'The access request is invalid.'
                : status === 428
                  ? 'Verify with your passkey before continuing.'
                  : 'Ofz is unavailable. Try again shortly.',
    )
    this.cause = cause
    this.name = 'OfzError'
  }
}

export function isOfzConfigured() {
  return Boolean(
    process.env.OFZ_GRPC_ENDPOINT?.trim() &&
    process.env.SPIFFE_ENDPOINT_SOCKET?.trim() &&
    process.env.SPIFFE_ID?.trim() === BFF_ID,
  )
}

async function getClient() {
  const target = process.env.OFZ_GRPC_ENDPOINT?.trim()
  const endpoint = process.env.SPIFFE_ENDPOINT_SOCKET?.trim()
  if (!target || !endpoint || process.env.SPIFFE_ID?.trim() !== BFF_ID) throw new OfzError(503)
  const nextConfiguration = JSON.stringify([target, endpoint])
  if (!source || configuration !== nextConfiguration) {
    client?.close()
    client = undefined
    source?.close()
    source = new SpiffeSource({
      endpoint,
      spiffeId: BFF_ID,
      protoPath:
        process.env.SPIFFE_WORKLOAD_API_PROTO_PATH?.trim() ??
        path.resolve(process.cwd(), '../../services/tengri/proto/spiffe/workloadapi.proto'),
    })
    configuration = nextConfiguration
  }
  const material = await source.material().catch((cause) => {
    throw new OfzError(503, '', cause)
  })
  if (client && fingerprint === material.fingerprint) return client
  const credentials = grpc.credentials.createSsl(material.bundle, material.privateKey, material.certificate, {
    checkServerIdentity: (_hostname, certificate) => verifySpiffePeer(OFZ_ID, certificate),
  })
  client = new grpc.Client(target, credentials, {
    'grpc.max_receive_message_length': 1_048_576,
    'grpc.max_send_message_length': 65536,
  })
  const current = client
  setTimeout(() => current.close(), Math.max(0, material.expiresAt - Date.now())).unref()
  fingerprint = material.fingerprint
  return client
}

export async function ofzCall<I extends DescMessage, O extends DescMessage>(
  method: DescMethodUnary<I, O>,
  input: MessageInitShape<I>,
  signal?: AbortSignal,
): Promise<MessageShape<O>> {
  const connection = await getClient()
  const metadata = new grpc.Metadata()
  metadata.set('x-ofz-contract-version', '1')
  const request = create(method.input, input)
  return new Promise((resolve, reject) => {
    const call = connection.makeUnaryRequest(
      `/${method.parent.typeName}/${method.name}`,
      (value) => Buffer.from(toBinary(method.input, value)),
      (value) => fromBinary(method.output, value),
      request,
      metadata,
      { deadline: Date.now() + (method.localName === 'check' ? 2000 : 5000) },
      (error, value) => {
        signal?.removeEventListener('abort', cancel)
        if (error) {
          const status =
            error.code === grpc.status.PERMISSION_DENIED &&
            error.details.includes('multifactor authentication required')
              ? 428
              : error.code === grpc.status.UNAUTHENTICATED
                ? 401
                : error.code === grpc.status.PERMISSION_DENIED
                  ? 403
                  : [grpc.status.ABORTED, grpc.status.ALREADY_EXISTS].includes(error.code)
                    ? 409
                    : error.code === grpc.status.FAILED_PRECONDITION && error.details.includes('MFA')
                      ? 428
                      : error.code === grpc.status.FAILED_PRECONDITION
                        ? 422
                        : error.code === grpc.status.INVALID_ARGUMENT
                          ? 400
                          : error.code === grpc.status.RESOURCE_EXHAUSTED
                            ? 429
                            : 503
          const receipt = error.metadata.get('x-ofz-audit-receipt')[0]
          reject(new OfzError(status, typeof receipt === 'string' ? receipt : '', error))
        } else if (value) resolve(value)
        else reject(new OfzError(503))
      },
    )
    function cancel() {
      call.cancel()
    }
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
  })
}
