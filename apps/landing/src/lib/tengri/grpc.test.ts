import { createHash, createHmac } from 'node:crypto'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { createSpiffeFixture } from './spiffe.fixture'
import { verifySpiffePeer } from './spiffe'
import { codexModelFixtures } from '../../components/tengri/codex-models.fixture'

void mock.module('server-only', () => ({}))

const secret = 'tengri-bff-test-secret-value-1234567890'
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
let receivedDeadline = 0
let terminalRequestStarted: (() => void) | null = null
let terminalRequestCancelled: (() => void) | null = null
let codexAccountRequestStarted: (() => void) | null = null
let codexAccountRequestCancelled: (() => void) | null = null
let renewingFileWatch: grpc.ServerWritableStream<Record<string, unknown>, Record<string, unknown>> | null = null

beforeAll(async () => {
  fixture = await createSpiffeFixture()
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
    revokeDesktopPreviews(
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
      receivedDeadline = Number(call.getDeadline())
      callback(null, {
        id: 'agent-test',
        displayName: String(call.request.displayName),
        phase: 'AGENT_PHASE_READY',
        architecture: 'ARCHITECTURE_ARM64',
        cpuMillis: 2_000,
        memoryMib: 4_096,
        workspaceGib: 16,
        ...(call.request.displayName === 'Old runtime' ? {} : { idleTimeoutMinutes: 60 }),
      })
    },
    resumeAgent(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      receivedDeadline = Number(call.getDeadline())
      callback(null, {
        id: call.request.id,
        displayName: 'Tengri',
        phase: 'AGENT_PHASE_READY',
        architecture: 'ARCHITECTURE_AMD64',
        cpuMillis: 4_000,
        memoryMib: 8_192,
        workspaceGib: 16,
        idleTimeoutMinutes: 60,
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
      if (id === 'authentication-failure') {
        callback(serviceError(grpc.status.UNAUTHENTICATED, 'internal verifier rejected tengri-runtime secret'), null)
        return
      }
      callback(serviceError(grpc.status.INTERNAL, 'pod 10.244.1.42 failed at an internal URL'), null)
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
  fixture.close()
})

describe('Tengri gRPC BFF transport', () => {
  test('renews the client certificate while an existing signed stream stays open', async () => {
    const { listCodexModels, watchFiles } = await import('./grpc')
    const watch = await watchFiles('github:42', 'agent-test', '/renewal')
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
      await listCodexModels('github:42', 'agent-test')
    }
    expect(state.tengriGrpcClient).not.toBe(before)
    expect(receivedMetadata?.get('x-tengri-subject')).toEqual(['github:42'])
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
      expect(await rejection(listCodexModels('github:42', 'agent-test'))).toMatchObject({ status: 503 })
    } finally {
      process.env.TENGRI_SPIFFE_ID = fixture.peerId
    }
    expect((await listCodexModels('github:42', 'agent-test')).models).toEqual(codexModelFixtures)
  })

  test('reads a validated guest catalog through the owner-signed transport', async () => {
    const { listCodexModels } = await import('./grpc')
    expect(await listCodexModels('github:42', 'agent-test', 'models-2')).toEqual({
      models: codexModelFixtures,
      nextCursor: null,
    })
    expect(receivedRequest).toMatchObject({ agentId: 'agent-test', cursor: 'models-2' })
    expect(receivedMetadata?.get('x-tengri-subject')).toEqual(['github:42'])
    expect(await rejection(listCodexModels('github:42', 'broken-catalog'))).toMatchObject({
      message: 'The guest returned an invalid Codex model catalog',
    })
  })

  test('carries model and reasoning choices over protobuf for new and subsequent turns', async () => {
    const { createCodexThread, sendCodexTurn } = await import('./grpc')
    const options = {
      model: 'gpt-6.1-sol',
      reasoningEffort: 'high',
    } satisfies import('./codex-models').TengriCodexOptions
    await createCodexThread('github:42', 'agent-test', options)
    expect(receivedRequest).toMatchObject({ agentId: 'agent-test', ...options })
    await sendCodexTurn('github:42', 'agent-test', 'thread-selected', 'Read the workspace', options)
    expect(receivedRequest).toMatchObject({ agentId: 'agent-test', threadId: 'thread-selected', ...options })
  })

  test('carries binary images through owner-signed mTLS for sends and steering', async () => {
    const { sendCodexTurn, steerCodexTurn } = await import('./grpc')
    const content = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
    const images = [{ mediaType: 'image/png' as const, data: content.toString('base64') }]
    await sendCodexTurn('github:42', 'agent-test', 'thread-selected', '', {}, images)
    expect(receivedRequest).toMatchObject({
      agentId: 'agent-test',
      text: '',
      images: [{ mediaType: 'image/png', content }],
    })
    expect(receivedMetadata?.get('x-tengri-subject')).toEqual(['github:42'])
    await steerCodexTurn('github:42', 'agent-test', 'thread-selected', 'turn-selected', 'Inspect this', images)
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
    expect(await rejection(listCodexModels('github:42', 'legacy-model-catalog'))).toMatchObject({
      status: 412,
      code: 'model_selection_unavailable',
    })
    expect(await rejection(listCodexModels('github:42', 'broken-catalog'))).toMatchObject({
      status: 503,
      code: undefined,
    })
  })

  test('revokes editor sessions for the authenticated subject without a caller-selected owner', async () => {
    const { revokeDesktopPreviews } = await import('./grpc')
    await revokeDesktopPreviews('github:42')
    expect(receivedRequest).toEqual({})
    expect(metadataValue('x-tengri-subject')).toBe('github:42')
    expect(metadataValue('x-tengri-signature')).not.toBe('')
  })

  test('binds real editor sessions to the window and revokes only their issued lease', async () => {
    const { issueEditorSession, revokePreviewSession } = await import('./grpc')
    const session = await issueEditorSession('github:42', 'agent-test', 'desktop-stable-code-window')
    expect(receivedRequest).toEqual({ agentId: 'agent-test', windowId: 'desktop-stable-code-window' })
    expect(session.id).toBe('a'.repeat(24))
    expect(metadataValue('x-tengri-subject')).toBe('github:42')
    await revokePreviewSession('github:42', 'agent-test', session.id, 'lease')
    expect(receivedRequest).toEqual({ agentId: 'agent-test', sessionId: session.id, revocationToken: 'lease' })
  })

  test('projects the public request and signs the GitHub subject for the Rust service', async () => {
    const { createAgent } = await import('./grpc')
    const agent = await createAgent('github:42', 'Tengri')

    expect(receivedRequest).toEqual({ displayName: 'Tengri' })
    expect(agent).toMatchObject({
      id: 'agent-test',
      displayName: 'Tengri',
      phase: 'ready',
      architecture: 'arm64',
      cpuMillis: 2_000,
      memoryMib: 4_096,
      workspaceGib: 16,
    })

    const subject = metadataValue('x-tengri-subject')
    const timestamp = metadataValue('x-tengri-timestamp')
    const nonce = metadataValue('x-tengri-nonce')
    const signature = metadataValue('x-tengri-signature')
    const method = descriptor.proompteng.runtime.v1.MicroVMControlPlane.service.CreateAgent
    const bodyHash = createHash('sha256')
      .update(method.requestSerialize({ displayName: 'Tengri' }))
      .digest('hex')
    expect(subject).toBe('github:42')
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{16,128}$/)
    expect(Number(timestamp)).toBeGreaterThan(0)
    expect(signature).toBe(
      createHmac('sha256', secret)
        .update(`${subject}\n${timestamp}\n${nonce}\n${method.path}\n${bodyHash}`)
        .digest('hex'),
    )
  })

  test('creation and resume retain the full synchronous lifecycle deadline', async () => {
    const { createAgent, resumeAgent } = await import('./grpc')
    for (const request of [() => createAgent('github:42', 'Tengri'), () => resumeAgent('github:42', 'agent-test')]) {
      const started = Date.now()
      expect((await request()).id).toBe('agent-test')
      expect(receivedDeadline).toBeGreaterThan(started + 300_000)
      expect(receivedDeadline).toBeLessThanOrEqual(Date.now() + 310_000)
    }
  })

  test('rejects non-UTF-8 files instead of corrupting their bytes', async () => {
    const { readFile } = await import('./grpc')
    const error = await rejection(readFile('github:42', 'agent-test', '/workspace/binary'))

    expect(error).toMatchObject({
      message: 'This file is not valid UTF-8 text',
      status: 415,
    })
  })

  test('persists power settings through the signed gRPC contract, including disabled automatic sleep', async () => {
    const { updatePowerSettings } = await import('./grpc')
    const agent = await updatePowerSettings('github:42', 'agent-test', {
      idleTimeoutMinutes: 0,
    })
    expect(receivedRequest).toEqual({
      id: 'agent-test',
      idleTimeoutMinutes: 0,
      _idleTimeoutMinutes: 'idleTimeoutMinutes',
    })
    expect(agent.power).toEqual({ idleTimeoutMinutes: 0 })
    expect(metadataValue('x-tengri-subject')).toBe('github:42')
    const method = descriptor.proompteng.runtime.v1.MicroVMControlPlane.service.UpdatePowerSettings
    const bodyHash = createHash('sha256')
      .update(
        method.requestSerialize({
          id: 'agent-test',
          idleTimeoutMinutes: 0,
        }),
      )
      .digest('hex')
    expect(metadataValue('x-tengri-signature')).toBe(
      createHmac('sha256', secret)
        .update(
          `github:42\n${metadataValue('x-tengri-timestamp')}\n${metadataValue('x-tengri-nonce')}\n${method.path}\n${bodyHash}`,
        )
        .digest('hex'),
    )
  })

  test('rejects an old runtime response rather than inventing its power settings', async () => {
    const { createAgent } = await import('./grpc')
    expect(await rejection(createAgent('github:42', 'Old runtime'))).toMatchObject({
      status: 503,
      message: 'The runtime returned invalid power settings. Update Tengri and refresh.',
    })
  })

  test('verifies file content revisions and rejects a mismatched read receipt', async () => {
    const { readFile } = await import('./grpc')
    const result = await readFile('github:42', 'agent-test', '/workspace/revision.txt')
    expect(result).toMatchObject({
      content: 'versioned content\n',
      revision: createHash('sha256').update('versioned content\n').digest('hex'),
    })
    expect(await rejection(readFile('github:42', 'agent-test', '/workspace/wrong-revision.txt'))).toMatchObject({
      status: 503,
    })
  })

  test('signs the file precondition and refuses unconfirmed save receipts', async () => {
    const { writeFile } = await import('./grpc')
    const content = 'saved content\n'
    const expectedRevision = 'a'.repeat(64)
    const result = await writeFile('github:42', 'agent-test', '/workspace/revision.txt', content, expectedRevision)
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
    const bodyHash = createHash('sha256').update(method.requestSerialize(receivedRequest)).digest('hex')
    expect(metadataValue('x-tengri-signature')).toBe(
      createHmac('sha256', secret)
        .update(
          `${metadataValue('x-tengri-subject')}\n${metadataValue('x-tengri-timestamp')}\n${metadataValue('x-tengri-nonce')}\n${method.path}\n${bodyHash}`,
        )
        .digest('hex'),
    )
    expect(
      await rejection(writeFile('github:42', 'agent-test', '/workspace/unconfirmed.txt', content, expectedRevision)),
    ).toMatchObject({ status: 503 })
    expect(
      await rejection(writeFile('github:42', 'agent-test', '/workspace/revision.txt', content, '0'.repeat(64))),
    ).toMatchObject({ status: 409, code: 'file_conflict' })
    expect(await rejection(writeFile('github:42', 'agent-test', '/workspace/revision.txt', content, ''))).toMatchObject(
      { status: 400 },
    )
  })

  test('preserves bounded file-search metadata from the control plane', async () => {
    const { searchFiles } = await import('./grpc')
    const result = await searchFiles('github:42', 'agent-test', '/workspace', 'main')

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
    const session = await issuePreviewSession('github:42', 'agent-test', 4321, '/app?mode=dev', '#editor')

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
    const stream = await watchFiles('github:42', 'agent-test', '/workspace')
    await new Promise<void>((resolve, reject) => {
      stream.on('error', reject)
      stream.on('end', resolve)
      stream.resume()
    })

    expect(receivedRequest).toMatchObject({ agentId: 'agent-test', path: '/workspace' })
    expect(receivedRequest).not.toHaveProperty('afterSequence')
    expect(receivedRequest?._afterSequence).toBeUndefined()
    const subject = metadataValue('x-tengri-subject')
    const timestamp = metadataValue('x-tengri-timestamp')
    const nonce = metadataValue('x-tengri-nonce')
    const method = descriptor.proompteng.runtime.v1.MicroVMControlPlane.service.WatchFiles
    const initialBody = method.requestSerialize({ agentId: 'agent-test', path: '/workspace' })
    const explicitZeroBody = method.requestSerialize({ agentId: 'agent-test', path: '/workspace', afterSequence: 0 })
    expect(explicitZeroBody.equals(initialBody)).toBeFalse()
    const bodyHash = createHash('sha256').update(initialBody).digest('hex')

    expect(metadataValue('x-tengri-signature')).toBe(
      createHmac('sha256', secret)
        .update(`${subject}\n${timestamp}\n${nonce}\n${method.path}\n${bodyHash}`)
        .digest('hex'),
    )

    const resumed = await watchFiles('github:42', 'agent-test', '/workspace', 0)
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
    const resumedBodyHash = createHash('sha256').update(explicitZeroBody).digest('hex')
    expect(metadataValue('x-tengri-signature')).toBe(
      createHmac('sha256', secret)
        .update(
          `${metadataValue('x-tengri-subject')}\n${metadataValue('x-tengri-timestamp')}\n${metadataValue('x-tengri-nonce')}\n${method.path}\n${resumedBodyHash}`,
        )
        .digest('hex'),
    )
  })

  test('projects terminal creation identity and cancels gRPC when the browser request aborts', async () => {
    const { createTerminal } = await import('./grpc')
    const terminal = await createTerminal('github:42', 'agent-test', 'terminal-creation-stable', '/workspace', 120, 32)
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
      'github:42',
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
    const pending = getCodexAccount('github:42', 'codex-account-cancel', controller.signal)

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
    expect(await getCodexLogin('github:42', 'agent-test')).toEqual({
      loginId: 'login-one',
      verificationUrl: 'https://auth.openai.com/device',
      userCode: 'TENG-RI01',
      expiresAt: '2026-08-31T09:15:00Z',
    })
    expect(await getCodexLogin('github:42', 'no-active-login')).toBeNull()
  })

  test('preserves a leading UTF-8 BOM for lossless editor round trips', async () => {
    const { readFile } = await import('./grpc')
    const file = await readFile('github:42', 'agent-test', '/workspace/bom.txt')

    expect(file.content).toBe('\ufeffhello')
  })

  test('sends current and previous signatures during HMAC rotation', async () => {
    const { createAgent } = await import('./grpc')
    const current = 'n'.repeat(32)
    process.env.TENGRI_INTERNAL_HMAC_SECRET = `${current},${secret}`

    try {
      await createAgent('github:42', 'Rotating Tengri')
      const subject = metadataValue('x-tengri-subject')
      const timestamp = metadataValue('x-tengri-timestamp')
      const nonce = metadataValue('x-tengri-nonce')
      const method = descriptor.proompteng.runtime.v1.MicroVMControlPlane.service.CreateAgent
      const bodyHash = createHash('sha256')
        .update(method.requestSerialize({ displayName: 'Rotating Tengri' }))
        .digest('hex')
      const payload = `${subject}\n${timestamp}\n${nonce}\n${method.path}\n${bodyHash}`

      expect(metadataValue('x-tengri-signature')).toBe(createHmac('sha256', current).update(payload).digest('hex'))
      expect(metadataValue('x-tengri-signature-previous')).toBe(
        createHmac('sha256', secret).update(payload).digest('hex'),
      )
    } finally {
      process.env.TENGRI_INTERNAL_HMAC_SECRET = secret
    }
  })

  test('preserves structured command approval decisions across gRPC', async () => {
    const { resolveCodexApproval } = await import('./grpc')

    await resolveCodexApproval('github:42', 'agent-test', 'approval-1', 'approve-exec-policy-amendment')
    expect(receivedRequest).toEqual({
      agentId: 'agent-test',
      approvalId: 'approval-1',
      decision: 'CODEX_APPROVAL_DECISION_APPROVE_EXEC_POLICY_AMENDMENT',
    })

    await resolveCodexApproval('github:42', 'agent-test', 'approval-2', 'approve-network-policy-amendment')
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

    expect(await rejection(resumeCodexThread('github:42', 'agent-test', 'invalid-sequence'))).toMatchObject({
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

    expect(await rejection(resumeCodexThread('github:42', 'agent-test', 'missing-conversation'))).toMatchObject({
      message: 'Codex conversation could not be found',
      status: 404,
      code: 'conversation_not_found',
    })
    expect(await rejection(resumeCodexThread('github:42', 'agent-test', 'missing-resource'))).toMatchObject({
      message: 'Tengri resource was not found',
      status: 404,
      code: undefined,
    })
    expect(await rejection(resumeCodexThread('github:42', 'agent-test', 'unavailable-conversation'))).toMatchObject({
      message: 'Tengri control plane is unavailable',
      status: 503,
      code: undefined,
    })
  })

  test('sanitizes upstream failures and treats verifier failures as service errors', async () => {
    const { getAgent } = await import('./grpc')
    const authenticationError = await rejection(getAgent('github:42', 'authentication-failure'))
    const internalError = await rejection(getAgent('github:42', 'internal-failure'))

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
    await resumeCodexThread('github:42', 'agent-test', threadId),
    threadId,
    undefined,
    (record) => new Error(String(record.error)),
  )
}
