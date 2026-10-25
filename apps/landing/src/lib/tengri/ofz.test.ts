import { afterAll, expect, mock, test } from 'bun:test'
import * as grpc from '@grpc/grpc-js'
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import {
  AuthorizationService,
  CheckRequestSchema,
  CheckResponseSchema,
  type CheckRequest,
  type CheckResponse,
} from './generated/proompteng/authz/v1/authz_pb'
import { createSpiffeFixture } from './spiffe.fixture'

void mock.module('server-only', () => ({}))
const { ofzCall, OfzError } = await import('./ofz')
// Keep one-time observability module loading outside the RPC deadline test.
await import('@/lib/observability/server')
const environment = {
  OFZ_GRPC_ENDPOINT: process.env.OFZ_GRPC_ENDPOINT,
  SPIFFE_ENDPOINT_SOCKET: process.env.SPIFFE_ENDPOINT_SOCKET,
  SPIFFE_ID: process.env.SPIFFE_ID,
  SPIFFE_WORKLOAD_API_PROTO_PATH: process.env.SPIFFE_WORKLOAD_API_PROTO_PATH,
}
let fixture: Awaited<ReturnType<typeof createSpiffeFixture>> | undefined
let server: grpc.Server | undefined
const timers = new Set<ReturnType<typeof setTimeout>>()

afterAll(() => {
  for (const timer of timers) clearTimeout(timer)
  server?.forceShutdown()
  fixture?.close()
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test('audited checks can wait for commit while receipt renewals keep their short deadline', async () => {
  const spiffe = await createSpiffeFixture()
  fixture = spiffe
  const identity = spiffe.certificate('ofz', 'spiffe://proompteng.ai/ns/ofz/sa/ofz-api')
  const service = new grpc.Server()
  server = service
  const check: grpc.handleUnaryCall<CheckRequest, CheckResponse> = (_call, callback) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      callback(
        null,
        create(CheckResponseSchema, {
          allowed: true,
          revision: 'fixture',
          auditReceiptId: '11111111-1111-4111-8111-111111111111',
          validUntilUnixMs: BigInt(Date.now() + 2000),
          recoveryGeneration: BigInt(1),
        }),
      )
    }, 6100)
    timers.add(timer)
  }
  service.addService(
    {
      check: {
        path: `/${AuthorizationService.typeName}/Check`,
        requestStream: false,
        responseStream: false,
        requestSerialize: (value: CheckRequest) => Buffer.from(toBinary(CheckRequestSchema, value)),
        requestDeserialize: (value: Buffer) => fromBinary(CheckRequestSchema, value),
        responseSerialize: (value: CheckResponse) => Buffer.from(toBinary(CheckResponseSchema, value)),
        responseDeserialize: (value: Buffer) => fromBinary(CheckResponseSchema, value),
      },
    },
    { check },
  )
  const port = await new Promise<number>((resolve, reject) =>
    service.bindAsync(
      '127.0.0.1:0',
      grpc.ServerCredentials.createSsl(spiffe.bundle, [{ private_key: identity.key, cert_chain: identity.pem }], true),
      (error, port) => (error ? reject(error) : resolve(port)),
    ),
  )
  process.env.OFZ_GRPC_ENDPOINT = `localhost:${port}`
  process.env.SPIFFE_ENDPOINT_SOCKET = spiffe.endpoint
  process.env.SPIFFE_ID = spiffe.ownId
  process.env.SPIFFE_WORKLOAD_API_PROTO_PATH = spiffe.protoPath
  const decision = await ofzCall(AuthorizationService.method.check, {})
  expect(decision.allowed).toBe(true)
  expect(decision.validUntilUnixMs > BigInt(Date.now())).toBe(true)
  try {
    await ofzCall(AuthorizationService.method.check, { streamReceiptId: decision.auditReceiptId })
    throw new Error('receipt renewal exceeded its deadline')
  } catch (error) {
    expect(error).toBeInstanceOf(OfzError)
    if (!(error instanceof OfzError)) throw error
    expect(error.status).toBe(503)
  }
}, 15_000)
