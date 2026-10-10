import { createHash, createHmac, randomUUID } from 'node:crypto'
import { create, fromBinary } from '@bufbuild/protobuf'
import { RequestContextSchema, SessionSchema } from './generated/proompteng/authz/v1/authz_pb'
import type { TengriIdentity } from './auth'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { createSpiffeFixture } from './spiffe.fixture'
import { codexModelFixtures } from '../../components/tengri/codex-models.fixture'

void mock.module('server-only', () => ({}))
const { verifySpiffePeer } = await import('./spiffe')

const secret = '68'.repeat(32)
const workspaceUid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
let runtimeEpoch = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
let runtimePhase = 'AGENT_PHASE_READY'
let runtimePolicyVersion = 10
let runtimeDisplayName = 'Tengri'
const staleAgents: Record<string, unknown>[] = []
let delayedRuntimeReads = 0
let agentReads = 0
let removedAgent = false
let loseCommandResponse = false
let supersedeRuntimeCommand = false
const identity: TengriIdentity = {
  subject: 'github:42',
  user: { id: '42', name: 'Fixture', email: '', image: null },
  session: create(SessionSchema, {
    id: '11111111-1111-4111-8111-111111111111',
    humanId: createHash('sha256').update('github:42').digest('hex'),
    recoveryGeneration: BigInt(1),
  }),
}
function runtimeAgent(id: unknown) {
  return {
    id: String(id),
    uid: workspaceUid,
    runtimeEpoch,
    policyVersion: String(runtimePolicyVersion),
    displayName: runtimeDisplayName,
    phase: runtimePhase,
    architecture: 'ARCHITECTURE_ARM64',
    cpuMillis: 2000,
    memoryMib: 4096,
    workspaceGib: 32,
    idleTimeoutMinutes: 60,
  }
}
let ofzServer: grpc.Server
let receivedCommandDeadline = 0
const lifecycleReceipts = new Map<string, Record<string, unknown>>()
const lifecycleHashes = new Map<string, Buffer>()
let lifecycleVersion = 10
let createdReservation = ''

const protoPath = path.resolve(
  import.meta.dir,
  '../../../../../services/tengri/proto/proompteng/runtime/v1/microvm.proto',
)
const definition = protoLoader.loadSync(protoPath, {
  defaults: true,
  enums: String,
  keepCase: false,
  longs: String,
  oneofs: true,
})
const descriptor = grpc.loadPackageDefinition(definition) as unknown as {
  proompteng: {
    runtime: {
      v1: {
        MicroVMControlPlane: grpc.ServiceClientConstructor & { service: grpc.ServiceDefinition }
      }
    }
  }
}

let fixture: Awaited<ReturnType<typeof createSpiffeFixture>>
let server: grpc.Server
let receivedMetadata: grpc.Metadata | undefined
let receivedRequest: Record<string, unknown> | undefined
let terminalRequestStarted: (() => void) | null = null
let terminalRequestCancelled: (() => void) | null = null
let codexAccountRequestStarted: (() => void) | null = null
let codexAccountRequestCancelled: (() => void) | null = null
let renewingFileWatch: grpc.ServerWritableStream<Record<string, unknown>, Record<string, unknown>> | null = null

beforeAll(async () => {
  fixture = await createSpiffeFixture()
  const authzDescriptor = grpc.loadPackageDefinition(
    protoLoader.loadSync(path.resolve(import.meta.dir, '../../../../../proto/proompteng/authz/v1/authz.proto'), {
      defaults: true,
      keepCase: false,
      longs: String,
      enums: String,
      oneofs: true,
    }),
  ) as unknown as {
    proompteng: {
      authz: { v1: { AuthorizationService: grpc.ServiceClientConstructor & { service: grpc.ServiceDefinition } } }
    }
  }
  ofzServer = new grpc.Server()
  ofzServer.addService(authzDescriptor.proompteng.authz.v1.AuthorizationService.service, {
    getPolicyState(
      _call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      callback(null, {
        version: String(lifecycleVersion),
        recoveryGeneration: '1',
        archiveHealthy: true,
        fenced: false,
      })
    },
    getCommand(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      const receipt = lifecycleReceipts.get(String(call.request.operationId))
      if (
        receipt &&
        !Buffer.from(call.request.clientRequestHash as Uint8Array).equals(
          lifecycleHashes.get(String(call.request.operationId))!,
        )
      ) {
        callback(serviceError(grpc.status.ALREADY_EXISTS, 'operation payload changed'), null)
      } else if (receipt) callback(null, { receipt })
      else callback(serviceError(grpc.status.NOT_FOUND, 'operation not found'), null)
    },
    executeCommand(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      receivedCommandDeadline = Number(call.getDeadline())
      const id = String(call.request.operationId)
      const runtime = call.request.setWorkspaceRuntime as
        | { running: boolean; runtimeEpoch: string; workspaceUid: string }
        | undefined
      if (runtime && delayedRuntimeReads) {
        for (let index = 0; index < delayedRuntimeReads; index += 1) staleAgents.push(runtimeAgent('agent-test'))
        delayedRuntimeReads = 0
      }
      const receipt = {
        operationId: id,
        state: 'COMMAND_STATE_COMMITTED',
        version: String(++lifecycleVersion),
        revision: 'fixture-native-revision',
        auditReceiptId: randomUUID(),
        runtimeIntent: runtime,
      }
      lifecycleReceipts.set(id, receipt)
      lifecycleHashes.set(id, Buffer.from(call.request.clientRequestHash as Uint8Array))
      if (runtime) {
        runtimeEpoch = runtime.runtimeEpoch
        runtimePhase = runtime.running ? 'AGENT_PHASE_READY' : 'AGENT_PHASE_SLEEPING'
        runtimePolicyVersion = lifecycleVersion
        if (supersedeRuntimeCommand) {
          supersedeRuntimeCommand = false
          runtimeEpoch = randomUUID()
          runtimePhase = 'AGENT_PHASE_READY'
          runtimePolicyVersion = ++lifecycleVersion
        }
      }
      if (call.request.removeWorkspace) removedAgent = true
      if (loseCommandResponse) {
        loseCommandResponse = false
        callback(serviceError(grpc.status.UNAVAILABLE, 'committed reply lost'), null)
        return
      }
      callback(null, { receipt })
    },
  })
  const ofzPeer = fixture.certificate('ofz', 'spiffe://proompteng.ai/ns/ofz/sa/ofz-api')
  const ofzPort = await new Promise<number>((resolve, reject) =>
    ofzServer.bindAsync(
      '127.0.0.1:0',
      grpc.ServerCredentials.createSsl(fixture.bundle, [{ cert_chain: ofzPeer.pem, private_key: ofzPeer.key }], true),
      (error, port) => (error ? reject(error) : resolve(port)),
    ),
  )
  process.env.OFZ_GRPC_ENDPOINT = `localhost:${ofzPort}`
  process.env.TENGRI_DESKTOP_ORIGIN = 'https://proompteng.ai'
  server = new grpc.Server()
  server.addService(descriptor.proompteng.runtime.v1.MicroVMControlPlane.service, {
    issueEditorSession(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      receivedMetadata = call.metadata
      receivedRequest = call.request
      callback(null, {
        id: 'a'.repeat(24),
        launchUrl: 'https://tengri.example/v1/preview/open#lease',
        previewOrigin: `https://tengri-${'a'.repeat(24)}.example`,
        expiresAt: '2026-09-09T00:00:00Z',
      })
    },
    revokeEditorSessions(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      receivedMetadata = call.metadata
      receivedRequest = call.request
      callback(null, {})
    },
    revokePreviewSession(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      receivedRequest = call.request
      callback(null, {})
    },
    createAgent(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      receivedMetadata = call.metadata
      receivedRequest = call.request
      runtimeDisplayName = String(call.request.displayName)
      removedAgent = false
      if (createdReservation !== String(call.request.reservationId)) {
        runtimeEpoch = ''
        runtimePhase = 'AGENT_PHASE_SLEEPING'
        createdReservation = String(call.request.reservationId)
      }
      callback(null, {
        ...runtimeAgent('agent-test'),
        ...(call.request.displayName === 'Old runtime' ? { idleTimeoutMinutes: undefined } : {}),
      })
    },
    updatePowerSettings(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      receivedMetadata = call.metadata
      receivedRequest = call.request
      callback(null, {
        id: call.request.id,
        displayName: 'Tengri',
        uid: workspaceUid,
        runtimeEpoch,
        policyVersion: String(runtimePolicyVersion),
        phase: 'AGENT_PHASE_READY',
        architecture: 'ARCHITECTURE_ARM64',
        idleTimeoutMinutes: call.request.idleTimeoutMinutes,
      })
    },
    getAgent(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      const id = String(call.request.id)
      agentReads += 1
      if (removedAgent) {
        callback(serviceError(grpc.status.NOT_FOUND, 'workspace removed'), null)
        return
      }
      const stale = staleAgents.shift()
      if (stale) {
        callback(null, stale)
        return
      }
      if (id === 'authentication-failure') {
        callback(serviceError(grpc.status.UNAUTHENTICATED, 'internal verifier rejected tengri-runtime secret'), null)
        return
      }
      if (id === 'internal-failure')
        callback(serviceError(grpc.status.INTERNAL, 'pod 10.244.1.42 failed at an internal URL'), null)
      else callback(null, runtimeAgent(id))
    },
    createTerminal(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      receivedRequest = call.request
      if (call.request.creationId === 'terminal-creation-cancel') {
        terminalRequestStarted?.()
        const timer = setTimeout(
          () => callback(serviceError(grpc.status.DEADLINE_EXCEEDED, 'test request was not cancelled'), null),
          5_000,
        )
        call.on('cancelled', () => {
          clearTimeout(timer)
          terminalRequestCancelled?.()
        })
        return
      }
      callback(null, {
        id: 'terminal-session-test',
        creationId: String(call.request.creationId),
        cwd: String(call.request.cwd),
        createdAt: '2026-08-27T00:00:00Z',
        lastActivityAt: '2026-08-27T00:00:00Z',
        attached: false,
      })
    },
    listCodexModels(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      receivedMetadata = call.metadata
      receivedRequest = call.request
      if (call.request.agentId === 'legacy-model-catalog') {
        callback(serviceError(grpc.status.UNIMPLEMENTED, 'model/list is unavailable'), null)
        return
      }
      callback(null, {
        rawJson:
          call.request.agentId === 'broken-catalog'
            ? '{"data":[{}],"nextCursor":null}'
            : JSON.stringify({ data: codexModelFixtures, nextCursor: null }),
      })
    },
    createCodexThread(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      receivedMetadata = call.metadata
      receivedRequest = call.request
      callback(null, { id: 'thread-selected', rawJson: '{}', eventSequence: 0 })
    },
    sendCodexInput(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      receivedMetadata = call.metadata
      receivedRequest = call.request
      callback(null, { id: 'turn-selected', threadId: call.request.threadId })
    },
    steerCodexInput(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      receivedMetadata = call.metadata
      receivedRequest = call.request
      callback(null, { id: 'turn-selected', threadId: call.request.threadId })
    },
    getCodexAccount(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      if (call.request.agentId === 'codex-account-cancel') {
        codexAccountRequestStarted?.()
        const timer = setTimeout(
          () => callback(serviceError(grpc.status.DEADLINE_EXCEEDED, 'test request was not cancelled'), null),
          5_000,
        )
        call.on('cancelled', () => {
          clearTimeout(timer)
          codexAccountRequestCancelled?.()
        })
        return
      }
      callback(null, { authenticated: true, email: 'ada@example.test', plan: 'pro' })
    },
    getCodexLogin(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      if (call.request.agentId === 'no-active-login') {
        callback(serviceError(grpc.status.NOT_FOUND, 'no Codex device login is active'), null)
        return
      }
      callback(null, {
        loginId: 'login-one',
        verificationUrl: 'https://auth.openai.com/device',
        userCode: 'TENG-RI01',
        expiresAt: '2026-08-31T09:15:00Z',
      })
    },
    readFile(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      if (call.request.path === '/workspace/revision.txt' || call.request.path === '/workspace/wrong-revision.txt') {
        const content = Buffer.from('versioned content\n')
        callback(null, {
          path: String(call.request.path),
          content,
          contentType: 'text/plain',
          revision:
            call.request.path === '/workspace/revision.txt'
              ? createHash('sha256').update(content).digest('hex')
              : '0'.repeat(64),
        })
        return
      }
      if (call.request.path === '/workspace/bom.txt') {
        callback(null, {
          path: String(call.request.path),
          content: Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('hello')]),
          contentType: 'text/plain; charset=utf-8',
        })
        return
      }
      callback(null, {
        path: String(call.request.path),
        content: Buffer.from([0xff, 0xfe, 0x00]),
        contentType: 'application/octet-stream',
      })
    },
    writeFile(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      receivedRequest = call.request
      receivedMetadata = call.metadata
      if (call.request.expectedRevision === '0'.repeat(64)) {
        callback(serviceError(grpc.status.ALREADY_EXISTS, 'private guest conflict details'), null)
        return
      }
      if (!Buffer.isBuffer(call.request.content)) {
        callback(serviceError(grpc.status.INVALID_ARGUMENT, 'content bytes missing'), null)
        return
      }
      callback(null, {
        path: call.request.path,
        size: call.request.content.byteLength,
        revision:
          call.request.path === '/workspace/unconfirmed.txt'
            ? ''
            : createHash('sha256').update(call.request.content).digest('hex'),
      })
    },
    searchFiles(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      receivedRequest = call.request
      callback(null, {
        entries: [
          {
            name: 'main.ts',
            path: '/workspace/main.ts',
            directory: false,
            size: 42,
            modifiedAt: '2026-08-28T00:00:00Z',
          },
        ],
        truncated: true,
      })
    },
    issuePreviewSession(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      receivedRequest = call.request
      callback(null, {
        id: 'preview12345678901234567',
        launchUrl: 'https://tengri.example/v1/preview/open#ticket.signature',
        expiresAt: '2026-08-27T00:00:30Z',
        previewOrigin: 'https://tengri-preview12345678901234567.example',
      })
    },
    watchFiles(call: grpc.ServerWritableStream<Record<string, unknown>, Record<string, unknown>>) {
      receivedMetadata = call.metadata
      receivedRequest = call.request
      call.write({
        sequence: '1',
        kind: 'FILE_EVENT_KIND_RESET',
        path: String(call.request.path),
      })
      if (call.request.path === '/renewal') renewingFileWatch = call
      else call.end()
    },
    resolveCodexApproval(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      receivedRequest = call.request
      callback(null, {})
    },
    resumeCodexThread(call: grpc.ServerWritableStream<Record<string, unknown>, Record<string, unknown>>) {
      receivedRequest = call.request
      const threadId = String(call.request.threadId)
      if (threadId === 'missing-conversation') {
        call.emit('error', serviceError(grpc.status.NOT_FOUND, '{"error":"Codex conversation could not be found"}\n'))
        return
      }
      if (threadId === 'missing-resource') {
        call.emit(
          'error',
          serviceError(grpc.status.NOT_FOUND, '{"error":"internal resource at 10.244.1.42 is missing"}'),
        )
        return
      }
      if (threadId === 'unavailable-conversation') {
        call.emit('error', serviceError(grpc.status.UNAVAILABLE, '{"error":"Codex conversation could not be found"}'))
        return
      }
      call.write({
        part: 'CODEX_HISTORY_PART_THREAD',
        rawJson: JSON.stringify({
          thread: { id: threadId, historyMode: 'paginated', turns: [] },
        }),
        eventSequence: threadId === 'invalid-sequence' ? '18446744073709551615' : '42',
      })
      const paged = threadId === 'paged-thread' || threadId === 'outdated-item-cursor'
      call.write({
        part: 'CODEX_HISTORY_PART_ITEMS',
        rawJson: JSON.stringify({
          data: paged ? [{ turnId: 'turn-1', item: { id: 'message-1', type: 'agentMessage', text: 'Recovered' } }] : [],
          nextCursor: null,
        }),
        eventSequence: threadId === 'outdated-item-cursor' ? '41' : '52',
      })
      call.write({
        part: 'CODEX_HISTORY_PART_TURNS',
        rawJson: JSON.stringify({
          data: paged ? [{ id: 'turn-1', status: 'completed', items: [], itemsView: 'notLoaded' }] : [],
          nextCursor: null,
        }),
        eventSequence: '53',
      })
      call.end()
    },
  })
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync(
      '127.0.0.1:0',
      grpc.ServerCredentials.createSsl(
        fixture.bundle,
        [{ cert_chain: fixture.peer.pem, private_key: fixture.peer.key }],
        true,
      ),
      (error, boundPort) => {
        if (error) reject(error)
        else resolve(boundPort)
      },
    )
  })
  process.env.TENGRI_GRPC_ENDPOINT = `localhost:${port}`
  process.env.SPIFFE_ENDPOINT_SOCKET = fixture.endpoint
  process.env.SPIFFE_ID = fixture.ownId
  process.env.TENGRI_SPIFFE_ID = fixture.peerId
  process.env.SPIFFE_WORKLOAD_API_PROTO_PATH = fixture.protoPath
  process.env.TENGRI_INTERNAL_HMAC_SECRET = secret
  process.env.TENGRI_PROTO_PATH = protoPath
})

afterAll(async () => {
  const state = globalThis as typeof globalThis & {
    tengriGrpcClient?: grpc.Client
    tengriGrpcService?: unknown
    tengriSpiffeSource?: { close(): void }
  }
  state.tengriSpiffeSource?.close()
  delete state.tengriSpiffeSource
  state.tengriGrpcClient?.close()
  delete state.tengriGrpcClient
  delete state.tengriGrpcService
  await new Promise<void>((resolve) => server.tryShutdown(() => resolve()))
  ofzServer.forceShutdown()
  fixture.close()
})

describe('Tengri gRPC BFF transport', () => {
  test('renews the client certificate while an existing signed stream stays open', async () => {
    const { listCodexModels, watchFiles } = await import('./grpc')
    const watch = await watchFiles(identity, 'agent-test', '/renewal')
    const first = await new Promise<Record<string, unknown>>((resolve, reject) => {
      watch.once('data', resolve)
      watch.once('error', reject)
    })
    expect(first.sequence).toBe('1')
    const state = globalThis as typeof globalThis & { tengriGrpcClient?: grpc.Client; tengriSpiffeFingerprint?: string }
    const before = state.tengriGrpcClient
    fixture.rotate()
    const deadline = Date.now() + 2_000
    while (state.tengriGrpcClient === before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      await listCodexModels(identity, 'agent-test')
    }
    expect(state.tengriGrpcClient).not.toBe(before)
    expect(metadataContext().actor?.identity).toEqual({ case: 'humanId', value: identity.session.humanId })
    const next = new Promise<Record<string, unknown>>((resolve, reject) => {
      watch.once('data', resolve)
      watch.once('error', reject)
    })
    renewingFileWatch?.write({ sequence: '2', kind: 'FILE_EVENT_KIND_RESET', path: '/renewal' })
    expect((await next).sequence).toBe('2')
    watch.cancel()
    before?.close()
  })

  test('rejects a trusted certificate with the wrong destination SPIFFE ID', async () => {
    const { listCodexModels } = await import('./grpc')
    process.env.TENGRI_SPIFFE_ID = 'spiffe://proompteng.ai/ns/tengri/sa/another-service'
    try {
      expect(await rejection(listCodexModels(identity, 'agent-test'))).toMatchObject({ status: 503 })
    } finally {
      process.env.TENGRI_SPIFFE_ID = fixture.peerId
    }
    expect((await listCodexModels(identity, 'agent-test')).models).toEqual(codexModelFixtures)
  })

  test('reads a validated guest catalog through the owner-signed transport', async () => {
    const { listCodexModels } = await import('./grpc')
    expect(await listCodexModels(identity, 'agent-test', 'models-2')).toEqual({
      models: codexModelFixtures,
      nextCursor: null,
    })
    expect(receivedRequest).toMatchObject({ agentId: 'agent-test', cursor: 'models-2' })
    expect(metadataContext().actor?.identity).toEqual({ case: 'humanId', value: identity.session.humanId })
    expect(await rejection(listCodexModels(identity, 'broken-catalog'))).toMatchObject({
      message: 'The guest returned an invalid Codex model catalog',
    })
  })

  test('carries model and reasoning choices over protobuf for new and subsequent turns', async () => {
    const { createCodexThread, sendCodexTurn } = await import('./grpc')
    const options = {
      model: 'gpt-6.1-sol',
      reasoningEffort: 'high',
    } satisfies import('./codex-models').TengriCodexOptions
    await createCodexThread(identity, 'agent-test', options)
    expect(receivedRequest).toMatchObject({ agentId: 'agent-test', ...options })
    await sendCodexTurn(identity, 'agent-test', 'thread-selected', 'Read the workspace', options)
    expect(receivedRequest).toMatchObject({ agentId: 'agent-test', threadId: 'thread-selected', ...options })
  })

  test('carries binary images through owner-signed mTLS for sends and steering', async () => {
    const { sendCodexTurn, steerCodexTurn } = await import('./grpc')
    const content = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
    const images = [{ mediaType: 'image/png' as const, data: content.toString('base64') }]
    await sendCodexTurn(identity, 'agent-test', 'thread-selected', '', {}, images)
    expect(receivedRequest).toMatchObject({
      agentId: 'agent-test',
      text: '',
      images: [{ mediaType: 'image/png', content }],
    })
    expect(metadataContext().actor?.identity).toEqual({ case: 'humanId', value: identity.session.humanId })
    await steerCodexTurn(identity, 'agent-test', 'thread-selected', 'turn-selected', 'Inspect this', images)
    expect(receivedRequest).toMatchObject({
      turnId: 'turn-selected',
      text: 'Inspect this',
      images: [{ mediaType: 'image/png', content }],
    })
  })

  test('rejects the previous input contract without starting or steering a text-only turn', async () => {
    const oldController = new grpc.Server()
    const service = descriptor.proompteng.runtime.v1.MicroVMControlPlane.service
    let startedTurns = 0
    const oldInput = (
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) => {
      startedTurns += 1
      callback(null, { id: 'image-lost', threadId: call.request.threadId })
    }
    oldController.addService(
      {
        SendCodexTurn: {
          ...service.SendCodexInput,
          path: service.SendCodexInput.path.replace('SendCodexInput', 'SendCodexTurn'),
          originalName: 'sendCodexTurn',
        },
        SteerCodexTurn: {
          ...service.SteerCodexInput,
          path: service.SteerCodexInput.path.replace('SteerCodexInput', 'SteerCodexTurn'),
          originalName: 'steerCodexTurn',
        },
        GetCodexAccount: service.GetCodexAccount,
      },
      {
        sendCodexTurn: oldInput,
        steerCodexTurn: oldInput,
        getCodexAccount: (
          _call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
          callback: grpc.sendUnaryData<Record<string, unknown>>,
        ) => callback(null, { authenticated: true, plan: 'pro' }),
      },
    )
    const port = await new Promise<number>((resolve, reject) => {
      oldController.bindAsync(
        '127.0.0.1:0',
        grpc.ServerCredentials.createSsl(
          fixture.bundle,
          [{ cert_chain: fixture.peer.pem, private_key: fixture.peer.key }],
          true,
        ),
        (error, boundPort) => (error ? reject(error) : resolve(boundPort)),
      )
    })
    const client = new grpc.Client(
      `localhost:${port}`,
      grpc.credentials.createSsl(fixture.bundle, fixture.own.key, fixture.own.pem, {
        checkServerIdentity: (_hostname, certificate) => verifySpiffePeer(fixture.peerId, certificate),
      }),
    )
    const request = {
      agentId: 'agent-test',
      threadId: 'thread-selected',
      turnId: 'turn-selected',
      text: 'Inspect this',
      images: [{ mediaType: 'image/png', content: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) }],
    }
    const call = (method: grpc.MethodDefinition<Record<string, unknown>, Record<string, unknown>>) =>
      new Promise<unknown>((resolve, reject) => {
        client.makeUnaryRequest(
          method.path,
          method.requestSerialize,
          method.responseDeserialize,
          request,
          new grpc.Metadata(),
          { deadline: Date.now() + 3000 },
          (error, result) => (error ? reject(error) : resolve(result)),
        )
      })
    try {
      expect(await call(service.GetCodexAccount)).toMatchObject({ authenticated: true })
      expect(await rejection(call(service.SendCodexInput))).toMatchObject({ code: grpc.status.UNIMPLEMENTED })
      expect(await rejection(call(service.SteerCodexInput))).toMatchObject({ code: grpc.status.UNIMPLEMENTED })
      expect(startedTurns).toBe(0)
    } finally {
      client.close()
      oldController.forceShutdown()
    }
  })

  test('identifies unsupported model selection without disguising other catalog failures', async () => {
    const { listCodexModels } = await import('./grpc')
    expect(await rejection(listCodexModels(identity, 'legacy-model-catalog'))).toMatchObject({
      status: 412,
      code: 'model_selection_unavailable',
    })
    expect(await rejection(listCodexModels(identity, 'broken-catalog'))).toMatchObject({
      status: 503,
      code: undefined,
    })
  })

  test('revokes desktop previews for the authenticated subject without a caller-selected owner', async () => {
    const { revokeDesktopPreviews } = await import('./grpc')
    await revokeDesktopPreviews(identity)
    expect(receivedRequest).toEqual({})
    expect(metadataContext().sessionId).toBe(identity.session.id)
    expect(metadataValue('x-tengri-signature')).not.toBe('')
  })

  test('binds real editor sessions to the window and revokes only their issued lease', async () => {
    const { issueEditorSession, revokePreviewSession } = await import('./grpc')
    const session = await issueEditorSession(identity, 'agent-test', 'desktop-stable-code-window')
    expect(receivedRequest).toEqual({ agentId: 'agent-test', windowId: 'desktop-stable-code-window' })
    expect(session.id).toBe('a'.repeat(24))
    expect(metadataContext().sessionId).toBe(identity.session.id)
    await revokePreviewSession(identity, 'agent-test', session.id, 'lease')
    expect(receivedRequest).toEqual({ agentId: 'agent-test', sessionId: session.id, revocationToken: 'lease' })
  })

  test('reserves capacity before creation and starts the enrolled UID with a durable Ofz command', async () => {
    const { createAgent } = await import('./grpc')
    const before = lifecycleReceipts.size
    const operationId = randomUUID()
    const agent = await createAgent(identity, 'Tengri', operationId)
    expect(receivedRequest).toEqual({ displayName: 'Tengri', reservationId: operationId })
    expect(agent).toMatchObject({ id: 'agent-test', uid: workspaceUid, phase: 'ready', displayName: 'Tengri' })
    expect(agent.runtimeEpoch).toMatch(/^[0-9a-f-]{36}$/)
    expect(lifecycleReceipts.size).toBe(before + 2)
    const repeated = await createAgent(identity, 'Tengri', operationId)
    expect(repeated.runtimeEpoch).toBe(agent.runtimeEpoch)
    expect(lifecycleReceipts.size).toBe(before + 2)
  })

  test('keeps individual policy and controller requests bounded during lifecycle polling', async () => {
    const { resumeAgent } = await import('./grpc')
    const started = Date.now()
    expect((await resumeAgent(identity, 'agent-test', workspaceUid, randomUUID())).id).toBe('agent-test')
    expect(receivedCommandDeadline).toBeLessThanOrEqual(Date.now() + 5000)
    expect(receivedCommandDeadline).toBeGreaterThan(started)
  })

  test('waits for the controller to observe the committed version before acknowledging an already ready guest', async () => {
    const { resumeAgent } = await import('./grpc')
    const reads = agentReads
    delayedRuntimeReads = 2
    const agent = await resumeAgent(identity, 'agent-test', workspaceUid, randomUUID())
    expect(agentReads - reads).toBe(4)
    expect(agent.policyVersion).toBe(String(lifecycleVersion))
  })

  test('rejects a superseded resume receipt after a later sleep and new epoch without executing it again', async () => {
    const { resumeAgent, sleepAgent } = await import('./grpc')
    const originalId = randomUUID()
    const original = await resumeAgent(identity, 'agent-test', workspaceUid, originalId)
    await sleepAgent(identity, 'agent-test', workspaceUid, randomUUID())
    const next = await resumeAgent(identity, 'agent-test', workspaceUid, randomUUID())
    expect(next.runtimeEpoch).not.toBe(original.runtimeEpoch)
    const count = lifecycleReceipts.size
    expect(await rejection(resumeAgent(identity, 'agent-test', workspaceUid, originalId))).toMatchObject({
      status: 409,
      code: 'lifecycle_superseded',
    })
    expect(lifecycleReceipts.size).toBe(count)
  })

  test('does not acknowledge sleep when reconciliation has already observed a newer resume', async () => {
    const { sleepAgent } = await import('./grpc')
    supersedeRuntimeCommand = true
    expect(await rejection(sleepAgent(identity, 'agent-test', workspaceUid, randomUUID()))).toMatchObject({
      status: 409,
      code: 'lifecycle_superseded',
    })
    expect(runtimePhase).toBe('AGENT_PHASE_READY')
  })

  test('accepts a newer observed version when the requested epoch and phase still match', async () => {
    const { resumeAgent } = await import('./grpc')
    const operationId = randomUUID()
    const original = await resumeAgent(identity, 'agent-test', workspaceUid, operationId)
    runtimePolicyVersion = ++lifecycleVersion
    const recovered = await resumeAgent(identity, 'agent-test', workspaceUid, operationId)
    expect(recovered.runtimeEpoch).toBe(original.runtimeEpoch)
    expect(recovered.phase).toBe('ready')
  })

  test('recovers a committed runtime command after the reply is lost and rejects a changed external payload', async () => {
    const { createAgent, sleepAgent } = await import('./grpc')
    const before = lifecycleReceipts.size
    loseCommandResponse = true
    await sleepAgent(identity, 'agent-test', workspaceUid, randomUUID())
    expect(lifecycleReceipts.size).toBe(before + 1)
    const operationId = randomUUID()
    await createAgent(identity, 'Original name', operationId)
    const count = lifecycleReceipts.size
    expect(await rejection(createAgent(identity, 'Changed name', operationId))).toMatchObject({ status: 409 })
    expect(lifecycleReceipts.size).toBe(count)
    expect(runtimeDisplayName).toBe('Original name')
  })

  test('recovers deletion after the controller has removed the workspace without requiring its metadata', async () => {
    const { createAgent, deleteAgent } = await import('./grpc')
    await createAgent(identity, 'Delete fixture', randomUUID())
    const operationId = randomUUID()
    await deleteAgent(identity, 'agent-test', workspaceUid, operationId)
    const count = lifecycleReceipts.size
    const reads = agentReads
    await deleteAgent(identity, 'agent-test', workspaceUid, operationId)
    expect(lifecycleReceipts.size).toBe(count)
    expect(agentReads).toBe(reads)
    removedAgent = false
  })

  test('rejects non-UTF-8 files instead of corrupting their bytes', async () => {
    const { readFile } = await import('./grpc')
    const error = await rejection(readFile(identity, 'agent-test', '/workspace/binary'))

    expect(error).toMatchObject({
      message: 'This file is not valid UTF-8 text',
      status: 415,
    })
  })

  test('persists power settings through the signed gRPC contract, including disabled automatic sleep', async () => {
    const { updatePowerSettings } = await import('./grpc')
    const agent = await updatePowerSettings(identity, 'agent-test', {
      idleTimeoutMinutes: 0,
    })
    expect(receivedRequest).toEqual({
      id: 'agent-test',
      idleTimeoutMinutes: 0,
      _idleTimeoutMinutes: 'idleTimeoutMinutes',
    })
    expect(agent.power).toEqual({ idleTimeoutMinutes: 0 })
    expect(metadataContext().sessionId).toBe(identity.session.id)
    const method = descriptor.proompteng.runtime.v1.MicroVMControlPlane.service.UpdatePowerSettings
    expect(metadataValue('x-tengri-signature')).toBe(expectedSignature(method, receivedRequest ?? {}))
  })

  test('rejects an old runtime response rather than inventing its power settings', async () => {
    const { createAgent } = await import('./grpc')
    expect(await rejection(createAgent(identity, 'Old runtime', randomUUID()))).toMatchObject({
      status: 503,
      message: 'The runtime returned invalid power settings. Update Tengri and refresh.',
    })
  })

  test('verifies file content revisions and rejects a mismatched read receipt', async () => {
    const { readFile } = await import('./grpc')
    const result = await readFile(identity, 'agent-test', '/workspace/revision.txt')
    expect(result).toMatchObject({
      content: 'versioned content\n',
      revision: createHash('sha256').update('versioned content\n').digest('hex'),
    })
    expect(await rejection(readFile(identity, 'agent-test', '/workspace/wrong-revision.txt'))).toMatchObject({
      status: 503,
    })
  })

  test('signs the file precondition and refuses unconfirmed save receipts', async () => {
    const { writeFile } = await import('./grpc')
    const content = 'saved content\n'
    const expectedRevision = 'a'.repeat(64)
    const result = await writeFile(identity, 'agent-test', '/workspace/revision.txt', content, expectedRevision)
    expect(receivedRequest).toMatchObject({
      expectedRevision,
      path: '/workspace/revision.txt',
      content: Buffer.from(content),
    })
    expect(result).toEqual({
      path: '/workspace/revision.txt',
      size: Buffer.byteLength(content),
      revision: createHash('sha256').update(content).digest('hex'),
    })
    const method = descriptor.proompteng.runtime.v1.MicroVMControlPlane.service.WriteFile
    expect(metadataValue('x-tengri-signature')).toBe(expectedSignature(method, receivedRequest ?? {}))
    expect(
      await rejection(writeFile(identity, 'agent-test', '/workspace/unconfirmed.txt', content, expectedRevision)),
    ).toMatchObject({ status: 503 })
    expect(
      await rejection(writeFile(identity, 'agent-test', '/workspace/revision.txt', content, '0'.repeat(64))),
    ).toMatchObject({ status: 409, code: 'file_conflict' })
    expect(await rejection(writeFile(identity, 'agent-test', '/workspace/revision.txt', content, ''))).toMatchObject({
      status: 400,
    })
  })

  test('preserves bounded file-search metadata from the control plane', async () => {
    const { searchFiles } = await import('./grpc')
    const result = await searchFiles(identity, 'agent-test', '/workspace', 'main')

    expect(receivedRequest).toEqual({ agentId: 'agent-test', path: '/workspace', query: 'main', limit: 100 })
    expect(result).toEqual({
      entries: [
        {
          name: 'main.ts',
          path: '/workspace/main.ts',
          directory: false,
          size: 42,
          modifiedAt: '2026-08-28T00:00:00Z',
        },
      ],
      truncated: true,
    })
  })

  test('keeps the preview fragment separate from the guest proxy path', async () => {
    const { issuePreviewSession } = await import('./grpc')
    const session = await issuePreviewSession(identity, 'agent-test', 4321, '/app?mode=dev', '#editor')

    expect(receivedRequest).toEqual({
      agentId: 'agent-test',
      port: 4321,
      path: '/app?mode=dev',
      fragment: '#editor',
    })
    expect(session).toEqual({
      id: 'preview12345678901234567',
      launchUrl: 'https://tengri.example/v1/preview/open#ticket.signature',
      expiresAt: '2026-08-27T00:00:30Z',
      previewOrigin: 'https://tengri-preview12345678901234567.example',
    })
  })

  test('distinguishes an initial file watch from an explicit zero resume cursor', async () => {
    const { watchFiles } = await import('./grpc')
    const stream = await watchFiles(identity, 'agent-test', '/workspace')
    await new Promise<void>((resolve, reject) => {
      stream.on('error', reject)
      stream.on('end', resolve)
      stream.resume()
    })

    expect(receivedRequest).toMatchObject({ agentId: 'agent-test', path: '/workspace' })
    expect(receivedRequest).not.toHaveProperty('afterSequence')
    expect(receivedRequest?._afterSequence).toBeUndefined()
    const method = descriptor.proompteng.runtime.v1.MicroVMControlPlane.service.WatchFiles
    const initialBody = method.requestSerialize({ agentId: 'agent-test', path: '/workspace' })
    const explicitZeroBody = method.requestSerialize({ agentId: 'agent-test', path: '/workspace', afterSequence: 0 })
    expect(explicitZeroBody.equals(initialBody)).toBeFalse()

    expect(metadataValue('x-tengri-signature')).toBe(expectedSignature(method, receivedRequest ?? {}))

    const resumed = await watchFiles(identity, 'agent-test', '/workspace', 0)
    await new Promise<void>((resolve, reject) => {
      resumed.on('error', reject)
      resumed.on('end', resolve)
      resumed.resume()
    })
    expect(receivedRequest).toMatchObject({
      agentId: 'agent-test',
      path: '/workspace',
      afterSequence: '0',
      _afterSequence: 'afterSequence',
    })
    expect(metadataValue('x-tengri-signature')).toBe(expectedSignature(method, receivedRequest ?? {}))
  })

  test('projects terminal creation identity and cancels gRPC when the browser request aborts', async () => {
    const { createTerminal } = await import('./grpc')
    const terminal = await createTerminal(identity, 'agent-test', 'terminal-creation-stable', '/workspace', 120, 32)
    expect(receivedRequest).toEqual({
      agentId: 'agent-test',
      creationId: 'terminal-creation-stable',
      cwd: '/workspace',
      columns: 120,
      rows: 32,
    })
    expect(terminal).toMatchObject({
      id: 'terminal-session-test',
      creationId: 'terminal-creation-stable',
      cwd: '/workspace',
    })

    const started = new Promise<void>((resolve) => {
      terminalRequestStarted = resolve
    })
    const cancelled = new Promise<void>((resolve) => {
      terminalRequestCancelled = resolve
    })
    const controller = new AbortController()
    const pending = createTerminal(
      identity,
      'agent-test',
      'terminal-creation-cancel',
      '/workspace',
      120,
      32,
      controller.signal,
    )
    await started
    controller.abort()
    expect(await rejection(pending)).toMatchObject({ name: 'AbortError', message: 'Tengri request was canceled' })
    await Promise.race([
      cancelled,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('gRPC call was not cancelled')), 1_000)),
    ])
    terminalRequestStarted = null
    terminalRequestCancelled = null
  })

  test('cancels Codex account gRPC when the browser request aborts', async () => {
    const { getCodexAccount } = await import('./grpc')
    const started = new Promise<void>((resolve) => {
      codexAccountRequestStarted = resolve
    })
    const cancelled = new Promise<void>((resolve) => {
      codexAccountRequestCancelled = resolve
    })
    const controller = new AbortController()
    const pending = getCodexAccount(identity, 'codex-account-cancel', controller.signal)

    await started
    controller.abort()
    expect(await rejection(pending)).toMatchObject({ name: 'AbortError', message: 'Tengri request was canceled' })
    await Promise.race([
      cancelled,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('gRPC call was not cancelled')), 1_000)),
    ])
    codexAccountRequestStarted = null
    codexAccountRequestCancelled = null
  })

  test('restores an active Codex device login without creating another attempt', async () => {
    const { getCodexLogin } = await import('./grpc')
    expect(await getCodexLogin(identity, 'agent-test')).toEqual({
      loginId: 'login-one',
      verificationUrl: 'https://auth.openai.com/device',
      userCode: 'TENG-RI01',
      expiresAt: '2026-08-31T09:15:00Z',
    })
    expect(await getCodexLogin(identity, 'no-active-login')).toBeNull()
  })

  test('preserves a leading UTF-8 BOM for lossless editor round trips', async () => {
    const { readFile } = await import('./grpc')
    const file = await readFile(identity, 'agent-test', '/workspace/bom.txt')

    expect(file.content).toBe('\ufeffhello')
  })

  test('rejects legacy key bundles and reads a replaced single key for the next request', async () => {
    const { getAgent, updatePowerSettings } = await import('./grpc')
    process.env.TENGRI_INTERNAL_HMAC_SECRET = `${secret},${secret}`
    try {
      expect(await rejection(getAgent(identity, 'agent-test'))).toMatchObject({ status: 503 })
      process.env.TENGRI_INTERNAL_HMAC_SECRET = '6e'.repeat(32)
      await updatePowerSettings(identity, 'agent-test', { idleTimeoutMinutes: 60 })
      expect(receivedMetadata?.get('x-tengri-signature-previous')).toEqual([])
      expect(receivedMetadata?.get('x-tengri-subject')).toEqual([])
      expect(receivedMetadata?.get('x-tengri-timestamp')).toEqual([])
      expect(metadataValue('x-tengri-signature')).toBe(
        expectedSignature(
          descriptor.proompteng.runtime.v1.MicroVMControlPlane.service.UpdatePowerSettings,
          { id: 'agent-test', idleTimeoutMinutes: 60 },
          '6e'.repeat(32),
        ),
      )
    } finally {
      process.env.TENGRI_INTERNAL_HMAC_SECRET = secret
    }
  })

  test('preserves structured command approval decisions across gRPC', async () => {
    const { resolveCodexApproval } = await import('./grpc')

    await resolveCodexApproval(identity, 'agent-test', 'approval-1', 'approve-exec-policy-amendment')
    expect(receivedRequest).toEqual({
      agentId: 'agent-test',
      approvalId: 'approval-1',
      decision: 'CODEX_APPROVAL_DECISION_APPROVE_EXEC_POLICY_AMENDMENT',
    })

    await resolveCodexApproval(identity, 'agent-test', 'approval-2', 'approve-network-policy-amendment')
    expect(receivedRequest).toEqual({
      agentId: 'agent-test',
      approvalId: 'approval-2',
      decision: 'CODEX_APPROVAL_DECISION_APPROVE_NETWORK_POLICY_AMENDMENT',
    })
  })

  test('preserves the atomic event cursor returned with a resumed thread snapshot', async () => {
    const thread = await restoredThread('thread-test')
    expect(receivedRequest).toEqual({ agentId: 'agent-test', threadId: 'thread-test', model: '', reasoningEffort: '' })
    expect(thread).toEqual({
      id: 'thread-test',
      rawJson: '{"thread":{"id":"thread-test","historyMode":"paginated","turns":[]}}',
      eventSequence: 42,
      itemEventSequences: {},
    })
  })

  test('rejects an invalid event cursor returned with a thread snapshot', async () => {
    const { resumeCodexThread } = await import('./grpc')

    expect(await rejection(resumeCodexThread(identity, 'agent-test', 'invalid-sequence'))).toMatchObject({
      message: 'Tengri control plane returned an invalid Codex event cursor',
      status: 503,
    })
  })

  test('preserves item page cursors and rejects pages older than the recovery baseline', async () => {
    expect(await restoredThread('paged-thread')).toMatchObject({
      eventSequence: 42,
      itemEventSequences: { 'message-1': 52 },
    })
    expect(await rejection(restoredThread('outdated-item-cursor'))).toMatchObject({
      message: 'Codex conversation recovery returned invalid history: invalid event cursor',
    })
  })

  test('identifies only the guest missing-conversation response as recoverable with a new conversation', async () => {
    const { resumeCodexThread } = await import('./grpc')

    expect(await rejection(resumeCodexThread(identity, 'agent-test', 'missing-conversation'))).toMatchObject({
      message: 'Codex conversation could not be found',
      status: 404,
      code: 'conversation_not_found',
    })
    expect(await rejection(resumeCodexThread(identity, 'agent-test', 'missing-resource'))).toMatchObject({
      message: 'Tengri resource was not found',
      status: 404,
      code: undefined,
    })
    expect(await rejection(resumeCodexThread(identity, 'agent-test', 'unavailable-conversation'))).toMatchObject({
      message: 'Tengri control plane is unavailable',
      status: 503,
      code: undefined,
    })
  })

  test('sanitizes upstream failures and treats verifier failures as service errors', async () => {
    const { getAgent } = await import('./grpc')
    const authenticationError = await rejection(getAgent(identity, 'authentication-failure'))
    const internalError = await rejection(getAgent(identity, 'internal-failure'))

    expect(authenticationError).toMatchObject({
      message: 'Tengri control-plane authentication is unavailable',
      status: 503,
    })
    expect(internalError).toMatchObject({
      message: 'Tengri control plane is unavailable',
      status: 503,
    })
  })
})

function metadataValue(name: string) {
  const value = receivedMetadata?.get(name)[0]
  if (typeof value !== 'string') throw new Error(`missing ${name}`)
  return value
}

function serviceError(code: grpc.status, details: string): grpc.ServiceError {
  const error = new Error(details) as grpc.ServiceError
  error.code = code
  error.details = details
  error.metadata = new grpc.Metadata()
  return error
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected request to fail')
}

async function restoredThread(threadId: string) {
  const { resumeCodexThread } = await import('./grpc')
  const { readCodexHistory } = await import('./codex-history')
  return readCodexHistory(
    await resumeCodexThread(identity, 'agent-test', threadId),
    threadId,
    undefined,
    (record) => new Error(String(record.error)),
  )
}

function metadataContext() {
  const value = receivedMetadata?.get('x-tengri-context-bin')[0]
  if (!Buffer.isBuffer(value)) throw new Error('Missing binary signed context')
  return fromBinary(RequestContextSchema, value)
}
function expectedSignature(
  method: grpc.MethodDefinition<unknown, unknown>,
  body: Record<string, unknown>,
  key = secret,
) {
  const value = receivedMetadata?.get('x-tengri-context-bin')[0]
  if (!Buffer.isBuffer(value)) throw new Error('Missing binary signed context')
  const payload = [
    'tengri.ofz.v1',
    method.path,
    createHash('sha256').update(method.requestSerialize(body)).digest('hex'),
    metadataValue('x-tengri-nonce'),
    value.toString('base64url'),
    metadataValue('x-tengri-recovery-generation'),
  ].join('\n')
  return createHmac('sha256', Buffer.from(key, 'hex')).update(payload).digest('hex')
}
