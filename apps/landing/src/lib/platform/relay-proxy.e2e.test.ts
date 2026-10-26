import { expect, mock, test } from 'bun:test'
import * as grpc from '@grpc/grpc-js'
import * as loader from '@grpc/proto-loader'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { createSpiffeFixture } from '../tengri/spiffe.fixture'

void mock.module('server-only', () => ({}))
const { POST } = await import('../../app/api/platform/relay/agent/route')

test('the public proxy forwards exact execution and lookup bodies over attested TLS', async () => {
  const fixture = await createSpiffeFixture()
  const certificate = fixture.certificate('relay', 'spiffe://proompteng.ai/ns/relay/sa/relay')
  const protoRoot = path.resolve(import.meta.dir, '../../../../../proto')
  const descriptor = grpc.loadPackageDefinition(
    loader.loadSync(path.join(protoRoot, 'proompteng/relay/v1/relay.proto'), {
      includeDirs: [protoRoot],
      longs: String,
      defaults: true,
    }),
  )
  const namespace = descriptor.proompteng as grpc.GrpcObject
  const relayNamespace = namespace.relay as grpc.GrpcObject
  const version = relayNamespace.v1 as grpc.GrpcObject
  const service = version.RelayService as grpc.ServiceClientConstructor
  const server = new grpc.Server()
  const environment = Object.fromEntries(
    [
      'RELAY_GRPC_ENDPOINT',
      'SPIFFE_ID',
      'SPIFFE_ENDPOINT_SOCKET',
      'SPIFFE_WORKLOAD_API_PROTO_PATH',
      'TENGRI_DESKTOP_ORIGIN',
    ].map((key) => [key, process.env[key]]),
  )
  const operationId = '11111111-1111-4111-8111-111111111111'
  const authorizationReceiptId = '22222222-2222-4222-8222-222222222222'
  const executionReceiptId = '33333333-3333-4333-8333-333333333333'
  const lookupReceiptId = '44444444-4444-4444-8444-444444444444'
  const delegationId = '55555555-5555-4555-8555-555555555555'
  const original = Buffer.from(`{\n "operationId":"${operationId}", "arguments":{"value":"\\u00e9"}\n}`)
  const lookup = Buffer.from(JSON.stringify({ executionBody: original.toString('utf8'), binding: null, delegationId }))
  const requestHash = createHash('sha256').update(original).digest()
  let executions = 0
  let lookups = 0
  type Invocation = {
    subject: { clientService: string; delegation: { delegationId: string; credential: string; proof: string } }
    body: Buffer
  }
  function check(call: grpc.ServerUnaryCall<Invocation, unknown>, expected: Buffer) {
    expect(call.metadata.get('x-ofz-contract-version')).toEqual(['1'])
    expect(call.request.body.equals(expected)).toBe(true)
    expect(call.request.subject).toMatchObject({
      clientService: 'tengri-web',
      delegation: { delegationId, credential: 'a'.repeat(43), proof: 'fixture-proof' },
    })
  }
  server.addService(service.service, {
    execute(call: grpc.ServerUnaryCall<Invocation, unknown>, callback: grpc.sendUnaryData<unknown>) {
      executions += 1
      check(call, original)
      callback(null, {
        operationId,
        result: Buffer.from('fixture result'),
        contentType: 'text/plain',
        authorizationReceiptId,
        executionReceiptId,
      })
    },
    getExecution(call: grpc.ServerUnaryCall<Invocation, unknown>, callback: grpc.sendUnaryData<unknown>) {
      lookups += 1
      check(call, lookup)
      callback(null, {
        execution: {
          operationId,
          outcome: 'succeeded',
          authorizationReceiptId,
          executionReceiptId,
          upstreamStatus: 200,
          requestHash,
          resultHash: createHash('sha256').update('fixture result').digest(),
          updatedAtUnixMs: '1792970000000',
        },
        lookupReceiptId,
      })
    },
  })
  try {
    const port = await new Promise<number>((resolve, reject) =>
      server.bindAsync(
        '127.0.0.1:0',
        grpc.ServerCredentials.createSsl(
          fixture.bundle,
          [{ private_key: certificate.key, cert_chain: certificate.pem }],
          true,
        ),
        (error, port) => (error ? reject(error) : resolve(port)),
      ),
    )
    process.env.RELAY_GRPC_ENDPOINT = `localhost:${port}`
    process.env.SPIFFE_ID = fixture.ownId
    process.env.SPIFFE_ENDPOINT_SOCKET = fixture.endpoint
    process.env.SPIFFE_WORKLOAD_API_PROTO_PATH = fixture.protoPath
    process.env.TENGRI_DESKTOP_ORIGIN = 'https://proompteng.ai'
    const invoke = (value: unknown, host = 'proompteng.ai') =>
      POST(
        new Request('https://proompteng.ai/api/platform/relay/agent', {
          method: 'POST',
          headers: {
            host,
            'content-type': 'application/json',
            authorization: `DPoP ${'a'.repeat(43)}`,
            dpop: 'fixture-proof',
            'x-relay-delegation': delegationId,
          },
          body: JSON.stringify(value),
        }),
      )
    expect((await invoke({ body: original.toString('base64') })).status).toBe(400)
    expect((await invoke({ kind: 'execute', body: original.toString('base64') }, 'other.example')).status).toBe(403)
    expect(executions).toBe(0)
    expect(lookups).toBe(0)
    const observed = await invoke({ kind: 'lookup', body: lookup.toString('base64') })
    expect(observed.status).toBe(200)
    expect(await observed.json()).toMatchObject({
      lookupReceiptId,
      execution: {
        operationId,
        outcome: 'succeeded',
        requestHash: requestHash.toString('base64'),
        updatedAtUnixMs: '1792970000000',
      },
    })
    expect(executions).toBe(0)
    expect(lookups).toBe(1)
    const completed = await invoke({ kind: 'execute', body: original.toString('base64') })
    expect(completed.status).toBe(200)
    expect(await completed.json()).toEqual({
      operationId,
      result: 'fixture result',
      contentType: 'text/plain',
      authorizationReceiptId,
      executionReceiptId,
    })
    expect(executions).toBe(1)
    expect(lookups).toBe(1)
  } finally {
    server.forceShutdown()
    fixture.close()
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}, 12_000)
