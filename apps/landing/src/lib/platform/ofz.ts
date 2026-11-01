import 'server-only'

import * as grpc from '@grpc/grpc-js'
import { type DescMessage, type DescMethodUnary, type MessageInitShape, type MessageShape } from '@bufbuild/protobuf'
import { attestedCaller } from './rpc'

const OFZ_ID = 'spiffe://proompteng.ai/ns/ofz/sa/ofz-api'
const call = attestedCaller(() => ({ target: process.env.OFZ_GRPC_ENDPOINT?.trim() || '', peer: OFZ_ID }))

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
    process.env.SPIFFE_ID?.trim(),
  )
}

export async function ofzCall<I extends DescMessage, O extends DescMessage>(
  method: DescMethodUnary<I, O>,
  input: MessageInitShape<I>,
  signal?: AbortSignal,
): Promise<MessageShape<O>> {
  if (!isOfzConfigured()) throw new OfzError(503)
  try {
    const renewal = method.localName === 'check' && 'streamReceiptId' in input && Boolean(input.streamReceiptId)
    return await call(method, input, signal, renewal ? 2000 : 30_000)
  } catch (error) {
    throw platformRpcError(error)
  }
}

export function platformRpcError(error: unknown) {
  if (!(error instanceof Error) || !('code' in error)) return new OfzError(503, '', error)
  const failure = error as grpc.ServiceError
  const status =
    failure.code === grpc.status.PERMISSION_DENIED && failure.details.includes('multifactor authentication required')
      ? 428
      : failure.code === grpc.status.UNAUTHENTICATED
        ? 401
        : failure.code === grpc.status.PERMISSION_DENIED
          ? 403
          : failure.code === grpc.status.NOT_FOUND
            ? 404
            : [grpc.status.ABORTED, grpc.status.ALREADY_EXISTS].includes(failure.code)
              ? 409
              : failure.code === grpc.status.FAILED_PRECONDITION && failure.details.includes('MFA')
                ? 428
                : failure.code === grpc.status.FAILED_PRECONDITION
                  ? 422
                  : failure.code === grpc.status.INVALID_ARGUMENT
                    ? 400
                    : failure.code === grpc.status.RESOURCE_EXHAUSTED
                      ? 429
                      : 503
  const receipt = failure.metadata?.get('x-ofz-audit-receipt')[0]
  return new OfzError(status, typeof receipt === 'string' ? receipt : '', error)
}
