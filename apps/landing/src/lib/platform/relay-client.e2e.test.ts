import { expect, test } from 'bun:test'
import * as grpc from '@grpc/grpc-js'
import * as loader from '@grpc/proto-loader'
import path from 'node:path'
import { createSpiffeFixture } from '../tengri/spiffe.fixture'

const binary = process.env.RELAY_CLIENT_FIXTURE_BIN
const ownId = 'spiffe://proompteng.ai/ns/opencode/sa/opencode'
const relayId = 'spiffe://proompteng.ai/ns/relay/sa/relay'

test.skipIf(!binary)(
  'standalone OpenCode MCP client uses its own SPIFFE identity and checks the Relay peer',
  async () => {
    const fixture = await createSpiffeFixture()
    const client = fixture.certificate('opencode', ownId)
    fixture.include(client.svid)
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
    let executions = 0
    let server: grpc.Server | undefined
    try {
      for (const peerId of [relayId, 'spiffe://proompteng.ai/ns/tengri/sa/tengri']) {
        const certificate = fixture.certificate(peerId === relayId ? 'relay' : 'wrong-relay', peerId)
        server = new grpc.Server()
        server.addService(service.service, {
          listOperations(_call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) {
            callback(null, {
              operations: [
                {
                  connectorId: 'galactic',
                  name: 'status',
                  action: 'kubernetes.status.read',
                  description: 'Read pod status',
                  inputSchemaJson: Buffer.from(
                    '{"type":"object","properties":{"namespace":{"type":"string"}},"required":["namespace"]}',
                  ),
                  readOnly: true,
                  targets: [],
                },
              ],
            })
          },
          execute(
            call: grpc.ServerUnaryCall<
              { subject: { clientService: string; workloadId: string }; body: Buffer },
              unknown
            >,
            callback: grpc.sendUnaryData<unknown>,
          ) {
            executions += 1
            expect(call.metadata.get('x-ofz-contract-version')).toEqual(['1'])
            expect(call.request.subject.clientService).toBe('opencode')
            expect(call.request.subject.workloadId).toBe(ownId)
            const payload = JSON.parse(call.request.body.toString('utf8'))
            expect(payload.clientService).toBe('opencode')
            expect(payload.connectorId).toBe('galactic')
            expect(payload.operation).toBe('status')
            expect(payload.arguments).toEqual({ namespace: 'ofz' })
            expect(payload.binding).toBeNull()
            expect(payload.delegationId).toBeNull()
            callback(null, {
              operationId: payload.operationId,
              result: Buffer.from('fixture pod status'),
              contentType: 'application/json',
              authorizationReceiptId: '11111111-1111-4111-8111-111111111111',
              executionReceiptId: '22222222-2222-4222-8222-222222222222',
            })
          },
        })
        const port = await new Promise<number>((resolve, reject) =>
          server!.bindAsync(
            '127.0.0.1:0',
            grpc.ServerCredentials.createSsl(
              fixture.bundle,
              [{ private_key: certificate.key, cert_chain: certificate.pem }],
              true,
            ),
            (error, port) => (error ? reject(error) : resolve(port)),
          ),
        )
        const input =
          [
            { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
            { jsonrpc: '2.0', id: 2, method: 'tools/list' },
            {
              jsonrpc: '2.0',
              id: 3,
              method: 'tools/call',
              params: { name: 'galactic__status', arguments: { namespace: 'ofz' } },
            },
          ]
            .map((message) => JSON.stringify(message))
            .join('\n') + '\n'
        const process = Bun.spawn([binary!], {
          env: {
            ...globalThis.process.env,
            SPIFFE_ENDPOINT_SOCKET: fixture.endpoint,
            SPIFFE_ID: ownId,
            RELAY_CLIENT_SERVICE: 'opencode',
            RELAY_GRPC_TARGET: `localhost:${port}`,
          },
          stdin: new TextEncoder().encode(input),
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const timeout = setTimeout(() => process.kill(), 12_000)
        const [code, stdout, stderr] = await Promise.all([
          process.exited,
          new Response(process.stdout).text(),
          new Response(process.stderr).text(),
        ])
        clearTimeout(timeout)
        expect(code, stderr).toBe(0)
        const replies = stdout
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        expect(replies[0].result.protocolVersion).toBe('2025-03-26')
        if (peerId === relayId) {
          expect(replies[1].result.tools[0].name).toBe('galactic__status')
          expect(replies[2].result).toEqual({ content: [{ type: 'text', text: 'fixture pod status' }], isError: false })
        } else {
          expect(replies[1].error.code).toBe(-32000)
          expect(replies[2].error.code).toBe(-32000)
        }
        server.forceShutdown()
        server = undefined
      }
      expect(executions).toBe(1)
    } finally {
      server?.forceShutdown()
      fixture.close()
    }
  },
  30_000,
)
