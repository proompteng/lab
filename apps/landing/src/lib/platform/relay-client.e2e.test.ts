import { expect, test } from 'bun:test'
import * as grpc from '@grpc/grpc-js'
import * as loader from '@grpc/proto-loader'
import { createHash } from 'node:crypto'
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
    let lookups = 0
    let server: grpc.Server | undefined
    try {
      for (const scenario of [
        'success',
        'lost',
        'started',
        'forbidden',
        'not-found',
        'denied',
        'invalid-receipt',
        'invalid-text',
        'unavailable',
        'invalid',
        'wrong-peer',
      ]) {
        const upstreamFailure = scenario === 'forbidden' ? 403 : scenario === 'not-found' ? 404 : 0
        const recordedOutcome = upstreamFailure ? 'failed' : scenario === 'started' ? 'started' : 'succeeded'
        const providerResult = scenario === 'invalid-text' ? Buffer.from([0xff]) : Buffer.from('fixture pod status')
        const peerId = scenario === 'wrong-peer' ? 'spiffe://proompteng.ai/ns/tengri/sa/tengri' : relayId
        const certificate = fixture.certificate(scenario, peerId)
        let executionBody: Buffer | undefined
        const beforeExecutions = executions
        const beforeLookups = lookups
        server = new grpc.Server()
        server.addService(service.service, {
          listOperations(
            call: grpc.ServerUnaryCall<{ subject: { clientService: string; workloadId: string } }, unknown>,
            callback: grpc.sendUnaryData<unknown>,
          ) {
            expect(call.request.subject).toMatchObject({ clientService: 'opencode', workloadId: ownId })
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
            executionBody = Buffer.from(call.request.body)
            if (!['success', 'invalid-receipt', 'invalid-text'].includes(scenario)) {
              const code =
                upstreamFailure === 403 || scenario === 'denied'
                  ? grpc.status.PERMISSION_DENIED
                  : upstreamFailure === 404
                    ? grpc.status.NOT_FOUND
                    : grpc.status.UNAVAILABLE
              callback({ code, details: 'private fixture provider response' })
              return
            }
            callback(null, {
              operationId: payload.operationId,
              result: scenario === 'invalid-receipt' ? Buffer.from('private fixture result') : providerResult,
              contentType: 'application/json',
              authorizationReceiptId:
                scenario === 'invalid-receipt' ? 'invalid' : '11111111-1111-4111-8111-111111111111',
              executionReceiptId: '22222222-2222-4222-8222-222222222222',
            })
          },
          getExecution(
            call: grpc.ServerUnaryCall<
              { subject: { clientService: string; workloadId: string }; body: Buffer },
              unknown
            >,
            callback: grpc.sendUnaryData<unknown>,
          ) {
            lookups += 1
            expect(call.metadata.get('x-ofz-contract-version')).toEqual(['1'])
            expect(call.request.subject.clientService).toBe('opencode')
            expect(call.request.subject.workloadId).toBe(ownId)
            const lookup = JSON.parse(call.request.body.toString('utf8'))
            expect(lookup.executionBody).toBe(executionBody!.toString('utf8'))
            expect(lookup.binding).toBeNull()
            expect(lookup.delegationId).toBeNull()
            expect(call.request.body.equals(executionBody!)).toBe(false)
            if (scenario === 'unavailable' || scenario === 'denied') {
              callback({
                code: scenario === 'denied' ? grpc.status.PERMISSION_DENIED : grpc.status.UNAVAILABLE,
                details: 'private fixture lookup response',
              })
              return
            }
            const payload = JSON.parse(lookup.executionBody)
            callback(null, {
              execution: {
                operationId: scenario === 'invalid' ? '33333333-3333-4333-8333-333333333333' : payload.operationId,
                outcome: recordedOutcome,
                authorizationReceiptId: '11111111-1111-4111-8111-111111111111',
                executionReceiptId: '22222222-2222-4222-8222-222222222222',
                upstreamStatus: upstreamFailure || (scenario === 'started' ? 0 : 200),
                resultHash:
                  recordedOutcome === 'succeeded'
                    ? createHash('sha256').update(providerResult).digest()
                    : Buffer.alloc(0),
                requestHash: createHash('sha256').update(executionBody!).digest(),
                updatedAtUnixMs: Date.now().toString(),
              },
              lookupReceiptId: '44444444-4444-4444-8444-444444444444',
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
        if (scenario !== 'wrong-peer') {
          expect(replies[1].result.tools[0].name).toBe('galactic__status')
          const result = replies[2].result
          expect(result).toBeDefined()
          expect(stdout).not.toContain('private fixture')
          const operationId = JSON.parse(executionBody!.toString('utf8')).operationId
          expect(result._meta.relay.operationId).toBe(operationId)
          expect(executions - beforeExecutions).toBe(1)
          if (scenario === 'success') {
            expect(result).toMatchObject({
              content: [{ type: 'text', text: 'fixture pod status' }],
              isError: false,
              _meta: { relay: { outcome: 'succeeded', executionReceiptId: '22222222-2222-4222-8222-222222222222' } },
            })
            expect(lookups - beforeLookups).toBe(0)
          } else {
            expect(result.isError).toBe(true)
            expect(result.content[0].text).toContain('The request was not resent.')
            expect(result._meta.relay.outcome).toBe(
              ['unavailable', 'invalid', 'denied'].includes(scenario) ? 'unknown' : recordedOutcome,
            )
            if (upstreamFailure) {
              expect(result.content[0].text).toContain(upstreamFailure === 403 ? 'PermissionDenied' : 'NotFound')
              expect(result._meta.relay).toMatchObject({
                upstreamStatus: upstreamFailure,
                authorizationReceiptId: '11111111-1111-4111-8111-111111111111',
                executionReceiptId: '22222222-2222-4222-8222-222222222222',
                lookupReceiptId: '44444444-4444-4444-8444-444444444444',
              })
            }
            if (scenario === 'denied') expect(result._meta.relay).toEqual({ operationId, outcome: 'unknown' })
            if (['invalid-receipt', 'invalid-text'].includes(scenario)) {
              expect(result.content[0].text).toContain('DataLoss')
              expect(result._meta.relay.executionReceiptId).toBe('22222222-2222-4222-8222-222222222222')
            }
            expect(lookups - beforeLookups).toBe(1)
          }
        } else {
          expect(replies[1].error.code).toBe(-32000)
          expect(replies[2].error.code).toBe(-32000)
        }
        server.forceShutdown()
        server = undefined
      }
      expect(executions).toBe(10)
      expect(lookups).toBe(9)
    } finally {
      server?.forceShutdown()
      fixture.close()
    }
  },
  60_000,
)

test.skipIf(!binary)(
  'MCP tool pagination refreshes authority, rejects invalid cursors and never dispatches execution',
  async () => {
    const fixture = await createSpiffeFixture()
    fixture.include(fixture.certificate('pagination-client', ownId).svid)
    const certificate = fixture.certificate('pagination-relay', relayId)
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
    const catalog = Array.from({ length: 125 }, (_, index) => ({
      connectorId: index % 2 ? 'inventory' : 'galactic',
      name: `read_${index.toString().padStart(3, '0')}`,
      action: 'inventory.items.read',
      description: `Read approved resource ${index}`,
      inputSchemaJson: Buffer.from(
        JSON.stringify({ type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false }),
      ),
      readOnly: true,
      targets: [{ name: `Resource ${index}`, resource: { kind: 'inventory.account', id: `inventory/${index}` } }],
    }))
    let authorized = catalog
    let denied = false
    let discoveries = 0
    let executions = 0
    let lookups = 0
    const server = new grpc.Server()
    server.addService(service.service, {
      listOperations(
        call: grpc.ServerUnaryCall<{ subject: { clientService: string; workloadId: string } }, unknown>,
        callback: grpc.sendUnaryData<unknown>,
      ) {
        discoveries += 1
        expect(call.metadata.get('x-ofz-contract-version')).toEqual(['1'])
        expect(call.request.subject).toMatchObject({ clientService: 'opencode', workloadId: ownId })
        if (denied) {
          callback({ code: grpc.status.PERMISSION_DENIED, details: 'private authority denial' })
        } else {
          // Relay's connector map need not return operations in the same order on each discovery.
          callback(null, { operations: discoveries % 2 ? [...authorized].reverse() : authorized })
        }
      },
      execute(_call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) {
        executions += 1
        callback({ code: grpc.status.INTERNAL, details: 'listing must not dispatch Execute' })
      },
      getExecution(_call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) {
        lookups += 1
        callback({ code: grpc.status.INTERNAL, details: 'listing must not look up execution' })
      },
    })
    let child: ReturnType<typeof Bun.spawn<'pipe', 'pipe', 'pipe'>> | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
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
      child = Bun.spawn([binary!], {
        env: {
          ...process.env,
          SPIFFE_ENDPOINT_SOCKET: fixture.endpoint,
          SPIFFE_ID: ownId,
          RELAY_CLIENT_SERVICE: 'opencode',
          RELAY_GRPC_TARGET: `localhost:${port}`,
        },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      timeout = setTimeout(() => child?.kill(), 20_000)
      const stderr = new Response(child.stderr).text()
      const reader = child.stdout.getReader()
      const decoder = new TextDecoder()
      let buffered = ''
      let id = 0
      const request = async (method: string, params?: unknown) => {
        const requestId = ++id
        await child!.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`)
        await child!.stdin.flush()
        while (!buffered.includes('\n')) {
          const chunk = await reader.read()
          if (chunk.done) throw new Error(`relay-client exited before reply: ${await stderr}`)
          buffered += decoder.decode(chunk.value, { stream: true })
        }
        const end = buffered.indexOf('\n')
        const reply = JSON.parse(buffered.slice(0, end))
        buffered = buffered.slice(end + 1)
        expect(reply.jsonrpc).toBe('2.0')
        expect(reply.id).toBe(requestId)
        return reply
      }
      const list = async (cursor?: string) => {
        const before = discoveries
        const reply = await request('tools/list', cursor === undefined ? undefined : { cursor })
        expect(discoveries - before).toBe(1)
        expect(reply.error).toBeUndefined()
        expect(reply.result.tools.length).toBeLessThanOrEqual(50)
        return reply.result as {
          tools: {
            name: string
            description: string
            inputSchema: unknown
            annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean }
          }[]
          nextCursor?: string
        }
      }
      const invalid = async (params: unknown) => {
        const reply = await request('tools/list', params)
        expect(reply.error.code).toBe(-32602)
        expect(reply.result).toBeUndefined()
        expect(JSON.stringify(reply)).not.toContain('private')
      }
      const initialized = await request('initialize', { protocolVersion: '2025-03-26' })
      expect(initialized.result.protocolVersion).toBe('2025-03-26')
      // Notifications have no reply; the next request must still be correlated correctly.
      await child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
      const expectedNames = catalog.map((op) => `${op.connectorId}__${op.name}`).sort()
      const first = await list()
      expect(first.tools.map((tool) => tool.name)).toEqual(expectedNames.slice(0, 50))
      expect(first.tools[0]).toEqual({
        name: 'galactic__read_000',
        description: catalog[0]!.description,
        inputSchema: JSON.parse(catalog[0]!.inputSchemaJson.toString()),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      })
      expect(first.nextCursor).toMatch(/^[0-9a-f]{80}$/)
      expect(await list()).toEqual(first)
      const second = await list(first.nextCursor)
      expect(second.tools).toHaveLength(50)
      expect(second.nextCursor).toBeString()
      expect(second.nextCursor).not.toBe(first.nextCursor)
      const third = await list(second.nextCursor)
      expect(third.tools).toHaveLength(25)
      expect(third).not.toHaveProperty('nextCursor')
      const names = [...first.tools, ...second.tools, ...third.tools].map((tool) => tool.name)
      expect(names).toEqual(expectedNames)
      expect(new Set(names).size).toBe(125)
      expect(await list(first.nextCursor)).toEqual(second)

      for (const cursor of [
        null,
        1,
        {},
        [],
        '',
        'not-a-cursor',
        'a'.repeat(79),
        'a'.repeat(81),
        'é'.repeat(40),
        'a'.repeat(4096),
        '0'.repeat(80),
      ]) {
        await invalid({ cursor })
      }
      for (const params of [null, [], 'cursor']) await invalid(params)
      // Deliberately forge offsets while retaining a valid catalog fingerprint: zero, non-boundary,
      // end, beyond-end and integer overflow must not yield an empty or overlapping continuation.
      for (const offset of [
        '0000000000000000',
        '0000000000000001',
        '000000000000007d',
        '0000000000000096',
        'ffffffffffffffff',
      ]) {
        await invalid({ cursor: offset + first.nextCursor!.slice(16) })
      }
      await invalid({ cursor: first.nextCursor!.slice(0, 16) + 'f'.repeat(64) })

      // Invalidate even when names and count stay fixed, including resource-only authority changes.
      for (const change of [
        { description: 'Updated description' },
        { action: 'inventory.items.inspect' },
        { inputSchemaJson: Buffer.from('{"type":"object","properties":{},"additionalProperties":false}') },
        { readOnly: false },
        { targets: [{ name: 'Replacement', resource: { kind: 'inventory.account', id: 'inventory/replacement' } }] },
      ]) {
        authorized = [{ ...catalog[0]!, ...change }, ...catalog.slice(1)]
        const before = discoveries
        await invalid({ cursor: first.nextCursor })
        expect(discoveries - before).toBe(1)
      }
      authorized = [...catalog, { ...catalog[0]!, name: 'new_read' }]
      await invalid({ cursor: first.nextCursor })
      // Permission revocation removes previously advertised tools. Old cursors cannot disclose them.
      authorized = catalog.slice(0, -1)
      await invalid({ cursor: first.nextCursor })
      authorized = catalog.slice(110)
      await invalid({ cursor: first.nextCursor })
      const restricted = await list()
      expect(restricted.tools.map((tool) => tool.name)).toEqual(
        authorized.map((op) => `${op.connectorId}__${op.name}`).sort(),
      )
      expect(restricted).not.toHaveProperty('nextCursor')
      authorized = []
      await invalid({ cursor: second.nextCursor })
      expect(await list()).toEqual({ tools: [] })
      authorized = catalog
      denied = true
      const beforeDenial = discoveries
      const denial = await request('tools/list', { cursor: first.nextCursor })
      expect(discoveries - beforeDenial).toBe(1)
      expect(denial.error.code).toBe(-32000)
      expect(denial.result).toBeUndefined()
      expect(JSON.stringify(denial)).not.toContain('private authority denial')
      denied = false

      for (const size of [1, 50, 100, 101]) {
        authorized = catalog.slice(0, size)
        let page = await list()
        if (size === 100) await invalid({ cursor: '0000000000000064' + page.nextCursor!.slice(16) })
        let count = page.tools.length
        while (page.nextCursor !== undefined) {
          expect(page.tools).toHaveLength(50)
          page = await list(page.nextCursor)
          count += page.tools.length
        }
        expect(count).toBe(size)
        expect(page.tools).toHaveLength(size % 50 || 50)
        expect(page).not.toHaveProperty('nextCursor')
      }
      expect(executions).toBe(0)
      expect(lookups).toBe(0)
      await child.stdin.end()
      expect(await child.exited, await stderr).toBe(0)
      reader.releaseLock()
    } finally {
      clearTimeout(timeout)
      child?.kill()
      if (child) await child.exited
      server.forceShutdown()
      fixture.close()
    }
  },
  30_000,
)
