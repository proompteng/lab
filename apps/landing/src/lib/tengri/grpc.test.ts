import { createHash, createHmac, randomUUID, X509Certificate } from 'node:crypto'
import { create, fromBinary } from '@bufbuild/protobuf'
import { RequestContextSchema } from './generated/proompteng/authz/v1/authz_pb'
import { SessionSchema } from './generated/proompteng/authz/v1/platform_pb'
import type { PlatformIdentity } from '../platform/auth'
import path from 'node:path'
import { finished } from 'node:stream/promises'
import { once } from 'node:events'
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { createSpiffeFixture } from './spiffe.fixture'
import { codexModelFixtures } from '../../components/tengri/codex-models.fixture'

void mock.module('server-only', () => ({}))
const { verifySpiffePeer } = await import('./spiffe')
const client = await import('./grpc')

const secret = '68'.repeat(32)
const agentId = 'agent-test'
const workspaceUid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
let runtimeEpoch = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
let runtimePhase = 'AGENT_PHASE_READY'
let runtimePolicyVersion = 10
let runtimeDisplayName = 'Tengri'
let runtimeConditions: Record<string, unknown>[] = []
const staleAgents: Record<string, unknown>[] = []
let delayedRuntimeReads = 0
let agentReads = 0
let removedAgent = false
let cleanupComplete = true
let cleanupUnavailable = false
let removalCheck: (() => void) | undefined
const removalOperations = new Set<string>()
let loseCommandResponse = false
let supersedeRuntimeCommand = false
let conflictedConversationResumes = 0
const identity: PlatformIdentity = {
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
    conditions: runtimeConditions,
  }
}
let ofzServer: grpc.Server
let receivedCommandDeadline = 0
let receivedCreateDeadline = 0
const receivedTerminalDeadlines = new Map<string, number>()
let ofzDatabaseClockOffsetMs = 0
const lifecycleReceipts = new Map<string, Record<string, unknown>>()
const lifecycleHashes = new Map<string, Buffer>()
let lifecycleVersion = 10
let createdReservation = ''
let reservationFailure: { code: number; operationIds: string[] } | undefined

const protoPath = path.resolve(
  import.meta.dir,
  '../../../../../services/tengri/proto/proompteng/runtime/v1/microvm.proto',
)
const loaderOptions = { defaults: true, enums: String, keepCase: false, longs: String, oneofs: true } as const
type Service = grpc.ServiceClientConstructor & { service: grpc.ServiceDefinition }

const {
  proompteng: {
    runtime: {
      v1: { MicroVMControlPlane },
    },
  },
} = grpc.loadPackageDefinition(protoLoader.loadSync(protoPath, loaderOptions)) as unknown as {
  proompteng: { runtime: { v1: { MicroVMControlPlane: Service } } }
}
const runtimeService = MicroVMControlPlane.service

let fixture: Awaited<ReturnType<typeof createSpiffeFixture>>
let server: grpc.Server
let receivedMetadata: grpc.Metadata | undefined
let catalogCertificate: string | undefined
let receivedRequest: Record<string, unknown> | undefined
let receiverAudience = '77777777-7777-4777-8777-777777777777'
let receiverGuestApiProtocolVersion = 10
let fileWriteCalls = 0
type WireMessage = Record<string, unknown>
type UnaryCall = grpc.ServerUnaryCall<WireMessage, WireMessage>
type UnaryCallback = grpc.sendUnaryData<WireMessage>
type ServerStream = grpc.ServerWritableStream<WireMessage, WireMessage>

function recordReply(reply: WireMessage | ((request: WireMessage) => WireMessage)) {
  return (call: UnaryCall, callback: UnaryCallback) => {
    receivedRequest = call.request
    receivedMetadata = call.metadata
    callback(null, typeof reply === 'function' ? reply(call.request) : reply)
  }
}

let renewingFileWatch: ServerStream | null = null
let cancellation: { started: () => void; cancelled: () => void } | undefined

function holdUntilCancelled(call: UnaryCall, callback: UnaryCallback, timeoutMs: number) {
  const observer = cancellation
  const timer = setTimeout(
    () => callback(serviceError(grpc.status.DEADLINE_EXCEEDED, 'Fixture RPC was not cancelled'), null),
    timeoutMs,
  )
  call.once('cancelled', () => {
    clearTimeout(timer)
    observer?.cancelled()
  })
  observer?.started()
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(() => timeout.reject(new Error(label)), timeoutMs)
  try {
    return await Promise.race([promise, timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}

async function expectRpcCancellation(
  request: (signal: AbortSignal) => Promise<unknown>,
  clientTimeoutMs: number,
  serverTimeoutMs: number,
) {
  const started = Promise.withResolvers<void>()
  const cancelled = Promise.withResolvers<void>()
  cancellation = { started: started.resolve, cancelled: cancelled.resolve }
  const controller = new AbortController()
  try {
    const pending = request(controller.signal)
    // Observe early rejection too, so a failure before dispatch does not leak an unhandled promise.
    void pending.catch(() => {})
    await Promise.race([
      started.promise,
      pending.then(() => {
        throw new Error('Fixture RPC completed before it could be cancelled')
      }),
    ])
    controller.abort()
    const error = await withDeadline(rejection(pending), clientTimeoutMs, 'Client did not reject the aborted request')
    expect(error).toMatchObject({ name: 'AbortError', message: 'Tengri request was canceled' })
    await withDeadline(cancelled.promise, serverTimeoutMs, 'Server did not observe gRPC cancellation')
  } finally {
    controller.abort()
    cancellation = undefined
  }
}

beforeAll(async () => {
  fixture = await createSpiffeFixture()
  const {
    proompteng: {
      authz: {
        v1: { TengriAuthorizationService },
      },
    },
  } = grpc.loadPackageDefinition(
    protoLoader.loadSync(
      path.resolve(import.meta.dir, '../../../../../proto/proompteng/authz/v1/authz.proto'),
      loaderOptions,
    ),
  ) as unknown as { proompteng: { authz: { v1: { TengriAuthorizationService: Service } } } }
  ofzServer = new grpc.Server()
  ofzServer.addService(TengriAuthorizationService.service, {
    getPolicyState(_call: UnaryCall, callback: UnaryCallback) {
      callback(null, {
        version: String(lifecycleVersion),
        recoveryGeneration: '1',
        archiveHealthy: true,
        fenced: false,
      })
    },
    getCommand(call: UnaryCall, callback: UnaryCallback) {
      const receipt = lifecycleReceipts.get(String(call.request.operationId))
      if (
        receipt &&
        !Buffer.from(call.request.clientRequestHash as Uint8Array).equals(
          lifecycleHashes.get(String(call.request.operationId))!,
        )
      ) {
        callback(serviceError(grpc.status.ALREADY_EXISTS, 'operation payload changed'), null)
      } else if (receipt) {
        if (removalOperations.has(String(call.request.operationId)) && cleanupUnavailable) {
          callback(serviceError(grpc.status.UNAVAILABLE, 'cleanup status unavailable'), null)
          return
        }
        callback(null, {
          receipt,
          workspaceRemoved: removalOperations.has(String(call.request.operationId)) && cleanupComplete,
        })
        if (removalOperations.has(String(call.request.operationId))) removalCheck?.()
      } else callback(serviceError(grpc.status.NOT_FOUND, 'operation not found'), null)
    },
    executeCommand(call: UnaryCall, callback: UnaryCallback) {
      receivedCommandDeadline = Number(call.getDeadline())
      const context = call.request.context as { deadlineUnixMs: string }
      if (Number(context.deadlineUnixMs) > Date.now() - ofzDatabaseClockOffsetMs + 30_000) {
        callback(serviceError(grpc.status.DEADLINE_EXCEEDED, 'invalid command deadline'), null)
        return
      }
      const id = String(call.request.operationId)
      if (call.request.reserveWorkspace && reservationFailure) {
        reservationFailure.operationIds.push(id)
        callback(serviceError(reservationFailure.code, 'reservation fixture failure'), null)
        return
      }
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
      if (call.request.removeWorkspace) {
        removedAgent = true
        removalOperations.add(id)
      }
      if (loseCommandResponse) {
        loseCommandResponse = false
        callback(serviceError(grpc.status.UNAVAILABLE, 'committed reply lost'), null)
        return
      }
      callback(null, { receipt })
    },
  })
  const ofzPeer = fixture.certificate('ofz', 'spiffe://proompteng.ai/ns/ofz/sa/ofz-api')
  const ofzPort = await fixture.bindMtls(ofzServer, ofzPeer)
  process.env.OFZ_GRPC_ENDPOINT = `localhost:${ofzPort}`
  process.env.PLATFORM_WEB_ORIGIN = 'https://proompteng.ai'
  server = new grpc.Server()
  server.addService(runtimeService, {
    getRequestAudience(_call: UnaryCall, callback: UnaryCallback) {
      callback(null, { audience: receiverAudience, guestApiProtocolVersion: receiverGuestApiProtocolVersion })
    },
    issueEditorSession(call: UnaryCall, callback: UnaryCallback) {
      receivedMetadata = call.metadata
      receivedRequest = call.request
      if (call.request.windowId === 'desktop-editor-cancel') {
        holdUntilCancelled(call, callback, 5_000)
        return
      }
      callback(null, {
        id: 'a'.repeat(24),
        launchUrl: 'https://tengri.example/v1/preview/open#lease',
        previewOrigin: `https://tengri-${'a'.repeat(24)}.example`,
        expiresAt: '2026-09-09T00:00:00Z',
      })
    },
    issueBrowserSession: recordReply({
      id: 'b'.repeat(24),
      launchUrl: 'https://tengri.example/v1/preview/open#lease',
      previewOrigin: `https://tengri-${'b'.repeat(24)}.example`,
      expiresAt: '2026-09-09T00:00:00Z',
    }),
    revokeEditorSessions: recordReply({}),
    revokePreviewSession(call: UnaryCall, callback: UnaryCallback) {
      receivedRequest = call.request
      callback(null, {})
    },
    createAgent(call: UnaryCall, callback: UnaryCallback) {
      receivedCreateDeadline = Number(call.getDeadline())
      receivedMetadata = call.metadata
      receivedRequest = call.request
      if (call.request.displayName === 'Expired reservation') {
        callback({ code: grpc.status.FAILED_PRECONDITION, details: 'workspace reservation expired' })
        return
      }
      if (['Released reservation', 'Deleting workspace'].includes(String(call.request.displayName))) {
        callback({ code: grpc.status.FAILED_PRECONDITION, details: 'workspace reservation released' })
        return
      }
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
    updatePowerSettings(call: UnaryCall, callback: UnaryCallback) {
      receivedMetadata = call.metadata
      receivedRequest = call.request
      if (call.request.id === 'sleep-committed') {
        callback(serviceError(grpc.status.FAILED_PRECONDITION, 'automatic sleep already committed'))
        return
      }
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
    listAgents(_call: UnaryCall, callback: UnaryCallback) {
      callback(null, { agents: [runtimeAgent('agent-test')] })
    },
    getAgent(call: UnaryCall, callback: UnaryCallback) {
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
    terminateTerminal(call: UnaryCall, callback: UnaryCallback) {
      receivedTerminalDeadlines.set('termination', Number(call.getDeadline()))
      if (call.request.terminalId === 'terminal-compound-cancel') {
        holdUntilCancelled(call, callback, 1_000)
        return
      }
      callback(null, {})
    },
    issueTerminalTicket(call: UnaryCall, callback: UnaryCallback) {
      receivedTerminalDeadlines.set('ticket', Number(call.getDeadline()))
      if (call.request.terminalId === 'terminal-compound-cancel') {
        holdUntilCancelled(call, callback, 1_000)
        return
      }
      callback(null, {
        websocketUrl: 'wss://tengri.example/v1/terminal/ws',
        ticket: 'fixture-ticket',
        expiresAt: '2026-10-18T12:00:00Z',
      })
    },
    createTerminal(call: UnaryCall, callback: UnaryCallback) {
      receivedRequest = call.request
      if (call.request.creationId === 'terminal-creation-cancel') {
        holdUntilCancelled(call, callback, 5_000)
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
    listCodexThreads(_call: UnaryCall, callback: UnaryCallback) {
      callback(null, { rawJson: '{"data":[{}],"nextCursor":null}' })
    },
    listCodexModels(call: UnaryCall, callback: UnaryCallback) {
      catalogCertificate = call.getAuthContext().sslPeerCertificate?.fingerprint256
      receivedMetadata = call.metadata
      receivedRequest = call.request
      if (call.request.agentId === 'unimplemented-catalog') {
        callback(serviceError(grpc.status.UNIMPLEMENTED, 'model/list is unavailable'), null)
        return
      }
      if (call.request.agentId === 'retained-runtime-upgrade') {
        const error = serviceError(grpc.status.FAILED_PRECONDITION, 'retained guest protocol differs')
        error.metadata.set('x-tengri-error-code', 'runtime_upgrade_required')
        callback(error, null)
        return
      }
      if (call.request.agentId === 'catalog-cancel') {
        holdUntilCancelled(call, callback, 2_000)
        return
      }
      callback(null, {
        rawJson:
          call.request.agentId === 'broken-catalog'
            ? '{"data":[{}],"nextCursor":null}'
            : JSON.stringify({ data: codexModelFixtures, nextCursor: null }),
      })
    },
    createCodexThread: recordReply({ id: 'thread-selected', rawJson: '{}', eventSequence: 0 }),
    sendCodexInput: recordReply((request) => ({
      runId: request.operationId,
      agentId: request.agentId,
      threadId: request.threadId,
      stateJson: JSON.stringify({ phase: 'running', turnId: 'turn-selected' }),
    })),
    getActiveCodexRuns(call: UnaryCall, callback: UnaryCallback) {
      if (call.request.id === 'codex-run-read-cancel') {
        holdUntilCancelled(call, callback, 2_000)
        return
      }
      receivedMetadata = call.metadata
      receivedRequest = call.request
      callback(null, {
        runs:
          call.request.id === 'agent-empty'
            ? []
            : [
                {
                  runId: '11111111-1111-4111-8111-111111111111',
                  agentId: call.request.id,
                  threadId: 'thread-selected',
                  stateJson: JSON.stringify({ phase: 'running', turnId: 'turn-selected' }),
                },
              ],
      })
    },
    recoverCodexRun: recordReply({}),
    getCodexRun(call: UnaryCall, callback: UnaryCallback) {
      if (call.request.agentId === 'codex-run-read-cancel') {
        holdUntilCancelled(call, callback, 2_000)
        return
      }
      receivedMetadata = call.metadata
      receivedRequest = call.request
      callback(null, {
        runId: call.request.runId,
        agentId: call.request.agentId,
        threadId: 'thread-selected',
        stateJson: JSON.stringify({ phase: 'running', turnId: 'turn-selected' }),
      })
    },
    steerCodexInput(call: UnaryCall, callback: UnaryCallback) {
      if (call.request.text === 'not-dispatched') {
        callback(serviceError(grpc.status.FAILED_PRECONDITION, 'Codex control was not dispatched'), null)
        return
      }
      receivedMetadata = call.metadata
      receivedRequest = call.request
      callback(null, { id: 'turn-selected', threadId: call.request.threadId })
    },
    getCodexAccount(call: UnaryCall, callback: UnaryCallback) {
      if (call.request.agentId === 'codex-account-cancel') {
        holdUntilCancelled(call, callback, 5_000)
        return
      }
      callback(null, { authenticated: true, email: 'ada@example.test', plan: 'pro' })
    },
    getCodexLogin(call: UnaryCall, callback: UnaryCallback) {
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
    readFile(call: UnaryCall, callback: UnaryCallback) {
      receivedRequest = call.request
      if (
        String(call.request.path).startsWith('/workspace/.tengri-attachments/') ||
        call.request.path === '/workspace/chart.png'
      ) {
        const content = String(call.request.path).endsWith('.png')
          ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
          : Buffer.from('not an image')
        callback(null, {
          path: call.request.path,
          content,
          contentType: 'image/png',
          revision: createHash('sha256').update(content).digest('hex'),
        })
        return
      }
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
    writeFile(call: UnaryCall, callback: UnaryCallback) {
      fileWriteCalls += 1
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
    searchFiles(call: UnaryCall, callback: UnaryCallback) {
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
    issuePreviewSession(call: UnaryCall, callback: UnaryCallback) {
      receivedRequest = call.request
      callback(null, {
        id: 'preview12345678901234567',
        launchUrl: 'https://tengri.example/v1/preview/open#ticket.signature',
        expiresAt: '2026-08-27T00:00:30Z',
        previewOrigin: 'https://tengri-preview12345678901234567.example',
      })
    },
    watchFiles(call: ServerStream) {
      receivedMetadata = call.metadata
      receivedRequest = call.request
      call.write({
        sequence: '1',
        kind: 'FILE_EVENT_KIND_RESET',
        path: String(call.request.path),
      })
      if (call.request.path === '/workspace/renewal') renewingFileWatch = call
      else call.end()
    },
    resolveCodexApproval(call: UnaryCall, callback: UnaryCallback) {
      receivedRequest = call.request
      callback(null, {})
    },
    resumeCodexThread(call: ServerStream) {
      receivedRequest = call.request
      const threadId = String(call.request.threadId)
      if (threadId === 'missing-conversation') {
        call.emit('error', serviceError(grpc.status.NOT_FOUND, 'Codex conversation could not be found'))
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
        call.emit('error', serviceError(grpc.status.UNAVAILABLE, 'Codex conversation could not be found'))
        return
      }
      if (threadId === 'conflicted-conversation' && conflictedConversationResumes++ === 0) {
        call.emit('error', serviceError(grpc.status.ALREADY_EXISTS, 'private guest conflict details'))
        return
      }
      call.write({
        part: 'CODEX_HISTORY_PART_THREAD',
        rawJson: JSON.stringify({
          thread: { id: threadId, historyMode: 'paginated', turns: [] },
        }),
        eventSequence: threadId === 'invalid-sequence' ? '18446744073709551615' : '42',
      })
      const generated = threadId === 'thread-generated'
      const paged = threadId === 'paged-thread' || threadId === 'outdated-item-cursor' || generated
      call.write({
        part: 'CODEX_HISTORY_PART_ITEMS',
        rawJson: JSON.stringify({
          data: generated
            ? [
                {
                  turnId: 'turn-1',
                  item: {
                    id: 'exec-cat',
                    type: 'imageGeneration',
                    status: 'completed',
                    savedPath: '/home/nanoagent/.codex/generated_images/thread-generated/exec-cat.png',
                    result:
                      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
                  },
                },
              ]
            : paged
              ? [{ turnId: 'turn-1', item: { id: 'message-1', type: 'agentMessage', text: 'Recovered' } }]
              : [],
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
  const port = await fixture.bindMtls(server)
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
  server.forceShutdown()
  ofzServer.forceShutdown()
  fixture.close()
})

describe('Tengri gRPC BFF transport', () => {
  test('recovers the exact accepted run through the current signed session without sending input', async () => {
    const runId = '11111111-1111-4111-8111-111111111111'
    const operationId = '22222222-2222-4222-8222-222222222222'
    await client.recoverCodexRun(identity, 'agent-test', runId, operationId)
    expect(receivedRequest).toEqual({ agentId: 'agent-test', runId, operationId })
    expect(receivedMetadata?.get('x-tengri-signature')).toHaveLength(1)
  })

  test('identifies a recorded control that was rejected before native dispatch', async () => {
    await expectFailure(
      client.steerCodexTurn(
        identity,
        'agent-test',
        'thread-selected',
        'turn-selected',
        '22222222-2222-4222-8222-222222222222',
        '11111111-1111-4111-8111-111111111111',
        'not-dispatched',
      ),
      { status: 409, code: 'control_not_dispatched' },
    )
  })
  test('recovers the server-owned active run and distinguishes an empty workspace', async () => {
    const { getActiveCodexRuns } = client
    expect(await getActiveCodexRuns(identity, 'agent-test')).toEqual([
      {
        runId: '11111111-1111-4111-8111-111111111111',
        agentId: 'agent-test',
        threadId: 'thread-selected',
        state: { phase: 'running', turnId: 'turn-selected' },
      },
    ])
    expect(receivedRequest).toEqual({ id: 'agent-test', threadId: '' })
    expect(await getActiveCodexRuns(identity, 'agent-empty')).toEqual([])
  })
  test('carries the selected conversation in the signed active-run request', async () => {
    const runs = await client.getActiveCodexRuns(identity, 'agent-test', 'thread-selected')
    expect(receivedRequest).toEqual({ id: 'agent-test', threadId: 'thread-selected' })
    expect(runs).toHaveLength(1)
    expect(runs[0]?.threadId).toBe('thread-selected')
    const method = runtimeService.GetActiveCodexRuns
    expect(metadataValue('x-tengri-signature')).toBe(expectedSignature(method, receivedRequest ?? {}))
    expect(metadataValue('x-tengri-signature')).not.toBe(expectedSignature(method, { id: 'agent-test' }))
  })
  test('rejects an out-of-scope active-run response instead of treating the selected conversation as idle', async () => {
    await expectFailure(client.getActiveCodexRuns(identity, 'agent-test', 'thread-another'), {
      message: 'Invalid active run scope',
      status: 503,
    })
  })
  test('reads the current receiver audience for every request and rejects malformed bindings before submission', async () => {
    const { listCodexModels } = client
    try {
      await listCodexModels(identity, 'agent-test')
      expect(metadataValue('x-tengri-audience')).toBe(receiverAudience)
      receiverAudience = '88888888-8888-4888-8888-888888888888'
      await listCodexModels(identity, 'agent-test')
      expect(metadataValue('x-tengri-audience')).toBe(receiverAudience)
      receiverAudience = 'not-an-audience'
      const before = receivedRequest
      await expectFailure(listCodexModels(identity, 'agent-test'), {
        message: 'Tengri request audience is invalid',
        status: 503,
      })
      expect(receivedRequest).toBe(before)
    } finally {
      receiverAudience = '77777777-7777-4777-8777-777777777777'
    }
  })
  test('refuses incompatible controllers before sending canonical file writes', async () => {
    const { writeFile } = client
    const before = fileWriteCalls
    try {
      for (const version of [0, 4, 5, 6, 7, 8, 9, 11]) {
        receiverGuestApiProtocolVersion = version
        await expectFailure(writeFile(identity, 'agent-test', '/workspace/main.ts', 'protected', 'missing'), {
          status: 503,
        })
        expect(fileWriteCalls).toBe(before)
      }
    } finally {
      receiverGuestApiProtocolVersion = 10
    }
    await writeFile(identity, 'agent-test', '/workspace/main.ts', 'protected', 'missing')
    expect(fileWriteCalls).toBe(before + 1)
  })

  test('renews the client certificate while an existing signed stream stays open', async () => {
    const { listCodexModels, watchFiles } = client
    const watch = await watchFiles(identity, 'agent-test', '/workspace/renewal')
    try {
      const [first] = await once(watch, 'data')
      expect(first).toMatchObject({ sequence: '1' })
      await listCodexModels(identity, 'agent-test')
      const originalCertificate = new X509Certificate(fixture.own.pem).fingerprint256
      expect(catalogCertificate).toBe(originalCertificate)

      const rotated = fixture.rotate()
      const rotatedCertificate = new X509Certificate(rotated.x509Svid).fingerprint256
      expect(rotatedCertificate).not.toBe(originalCertificate)
      const deadline = Date.now() + 2_000
      while (catalogCertificate !== rotatedCertificate && Date.now() < deadline) {
        await Bun.sleep(10)
        await listCodexModels(identity, 'agent-test')
      }
      expect(catalogCertificate).toBe(rotatedCertificate)
      expect(metadataContext().actor?.identity).toMatchObject({ case: 'humanId', value: identity.session.humanId })
      const next = once(watch, 'data')
      renewingFileWatch?.write({ sequence: '2', kind: 'FILE_EVENT_KIND_RESET', path: '/workspace/renewal' })
      expect((await next)[0]).toMatchObject({ sequence: '2' })
    } finally {
      renewingFileWatch?.end()
      watch.resume()
      await finished(watch, { cleanup: true })
    }
  })

  test('rejects a trusted certificate with the wrong destination SPIFFE ID', async () => {
    const { listCodexModels } = client
    process.env.TENGRI_SPIFFE_ID = 'spiffe://proompteng.ai/ns/tengri/sa/another-service'
    try {
      await expectFailure(listCodexModels(identity, 'agent-test'), { status: 503 })
    } finally {
      process.env.TENGRI_SPIFFE_ID = fixture.peerId
    }
    expect((await listCodexModels(identity, 'agent-test')).models).toEqual(codexModelFixtures)
  })

  test('reads a validated guest catalog through the owner-signed transport', async () => {
    const { listCodexModels } = client
    expect(await listCodexModels(identity, 'agent-test', 'models-2')).toEqual({
      models: codexModelFixtures,
      nextCursor: null,
    })
    expect(receivedRequest).toMatchObject({ agentId: 'agent-test', cursor: 'models-2' })
    expect(metadataContext().actor?.identity).toEqual({ case: 'humanId', value: identity.session.humanId })
    expect(metadataContext().deadlineUnixMs).toBeLessThanOrEqual(BigInt(Date.now() - 250 + 5000))
    await expectFailure(listCodexModels(identity, 'broken-catalog'), {
      message: 'The guest returned an invalid Codex model catalog',
    })
  })

  test('carries model and reasoning choices over protobuf for new and subsequent turns', async () => {
    const { createCodexThread, sendCodexTurn } = client
    const options = {
      model: 'gpt-6.2-sol',
      reasoningEffort: 'high',
    } satisfies import('./codex-models').TengriCodexOptions
    await createCodexThread(identity, 'agent-test', options)
    expect(receivedRequest).toMatchObject({ agentId: 'agent-test', ...options })
    await sendCodexTurn(
      identity,
      'agent-test',
      'thread-selected',
      '11111111-1111-4111-8111-111111111111',
      'Read the workspace',
      options,
    )
    expect(receivedRequest).toMatchObject({ agentId: 'agent-test', threadId: 'thread-selected', ...options })
  })

  test('carries binary images through owner-signed mTLS for sends and steering', async () => {
    const { sendCodexTurn, steerCodexTurn } = client
    const content = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
    const images = [{ mediaType: 'image/png' as const, data: content.toString('base64') }]
    await sendCodexTurn(
      identity,
      'agent-test',
      'thread-selected',
      '11111111-1111-4111-8111-111111111111',
      '',
      {},
      images,
    )
    expect(receivedRequest).toMatchObject({
      agentId: 'agent-test',
      text: '',
      images: [{ mediaType: 'image/png', content }],
    })
    expect(metadataContext().actor?.identity).toEqual({ case: 'humanId', value: identity.session.humanId })
    await steerCodexTurn(
      identity,
      'agent-test',
      'thread-selected',
      'turn-selected',
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111',
      'Inspect this',
      images,
    )
    expect(receivedRequest).toMatchObject({
      turnId: 'turn-selected',
      text: 'Inspect this',
      images: [{ mediaType: 'image/png', content }],
    })
  })

  test('rejects the previous input contract without starting or steering a text-only turn', async () => {
    const oldController = new grpc.Server()
    const service = runtimeService
    let startedTurns = 0
    const oldInput = (call: UnaryCall, callback: UnaryCallback) => {
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
        getCodexAccount: (_call: UnaryCall, callback: UnaryCallback) =>
          callback(null, { authenticated: true, plan: 'pro' }),
      },
    )
    const port = await fixture.bindMtls(oldController)
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
      await expectFailure(call(service.SendCodexInput), { code: grpc.status.UNIMPLEMENTED })
      await expectFailure(call(service.SteerCodexInput), { code: grpc.status.UNIMPLEMENTED })
      expect(startedTurns).toBe(0)
    } finally {
      client.close()
      oldController.forceShutdown()
    }
  })

  test('classifies malformed chat indexes as validation failures', async () => {
    await expectFailure(client.listCodexThreads(identity, 'agent-test', false), {
      status: 502,
      code: 'chat_index_invalid',
    })
  })

  test('treats missing model RPCs and invalid catalogs as failures without negotiating guest capabilities', async () => {
    const { listCodexModels } = client
    await expectFailure(listCodexModels(identity, 'unimplemented-catalog'), {
      status: 503,
      code: undefined,
    })
    await expectFailure(listCodexModels(identity, 'broken-catalog'), {
      status: 502,
      code: 'model_catalog_invalid',
    })
  })

  test('revokes desktop previews for the authenticated subject without a caller-selected owner', async () => {
    await client.revokeDesktopPreviews(identity)
    expect(receivedRequest).toEqual({})
    expect(metadataContext().sessionId).toBe(identity.session.id)
    expect(metadataValue('x-tengri-signature')).not.toBe('')
  })

  test('signs browser renewal with its exact agent and desktop window identity', async () => {
    const session = await client.issueBrowserSession(
      identity,
      'agent-test',
      'desktop-stable-browser-window',
      true,
      new AbortController().signal,
    )
    expect(receivedRequest).toEqual({ agentId: 'agent-test', windowId: 'desktop-stable-browser-window', renewal: true })
    expect(session.id).toBe('b'.repeat(24))
    expect(metadataContext().sessionId).toBe(identity.session.id)
    expect(metadataValue('x-tengri-signature')).not.toBe('')
  })

  test('binds real editor sessions to the window and revokes only their issued lease', async () => {
    const { issueEditorSession, revokePreviewSession } = client
    const session = await issueEditorSession(
      identity,
      'agent-test',
      'desktop-stable-code-window',
      false,
      new AbortController().signal,
    )
    expect(receivedRequest).toEqual({ agentId: 'agent-test', windowId: 'desktop-stable-code-window', renewal: false })
    expect(session.id).toBe('a'.repeat(24))
    expect(metadataContext().sessionId).toBe(identity.session.id)
    await revokePreviewSession(identity, 'agent-test', session.id, 'lease')
    expect(receivedRequest).toEqual({ agentId: 'agent-test', sessionId: session.id, revocationToken: 'lease' })
  })

  test('cancels the editor launch RPC when its HTTP request aborts', async () => {
    await expectRpcCancellation(
      (signal) => client.issueEditorSession(identity, 'agent-test', 'desktop-editor-cancel', false, signal),
      300,
      1_000,
    )
  })

  test('keeps compound terminal calls within the shared guest-operation budget', async () => {
    const { terminateTerminal, issueTerminalTicket } = client
    const started = Date.now()
    await terminateTerminal(identity, 'agent-test', 'terminal-test')
    const ticket = await issueTerminalTicket(identity, 'agent-test', 'terminal-test')
    expect(ticket.ticket).toBe('fixture-ticket')
    for (const method of ['termination', 'ticket']) {
      expect(receivedTerminalDeadlines.get(method)).toBeGreaterThanOrEqual(started + 2 * 30_000)
      expect(receivedTerminalDeadlines.get(method)).toBeLessThanOrEqual(Date.now() + 130_000)
    }
  })

  test.each(['terminateTerminal', 'issueTerminalTicket'] as const)(
    'cancels compound terminal RPC %s when its HTTP request aborts',
    async (method) => {
      await expectRpcCancellation(
        (signal) => client[method](identity, 'agent-test', 'terminal-compound-cancel', signal),
        300,
        1_000,
      )
    },
  )

  test('creates a workspace when the Ofz database clock trails the BFF by one second', async () => {
    ofzDatabaseClockOffsetMs = 1000
    try {
      expect(await client.createAgent(identity, 'Tengri', randomUUID())).toMatchObject({
        id: 'agent-test',
        phase: 'ready',
      })
    } finally {
      ofzDatabaseClockOffsetMs = 0
    }
  })

  test('reserves capacity before creation and starts the enrolled UID with a durable Ofz command', async () => {
    const { createAgent } = client
    const before = lifecycleReceipts.size
    const operationId = randomUUID()
    const started = Date.now()
    const agent = await createAgent(identity, 'Tengri', operationId)
    expect(receivedCreateDeadline).toBeGreaterThanOrEqual(started + 4 * 30_000)
    expect(receivedCreateDeadline).toBeLessThanOrEqual(Date.now() + 130_000)
    expect(receivedRequest).toEqual({ displayName: 'Tengri', reservationId: operationId })
    expect(agent).toMatchObject({ id: 'agent-test', uid: workspaceUid, phase: 'ready', displayName: 'Tengri' })
    expect(agent.runtimeEpoch).toMatch(/^[0-9a-f-]{36}$/)
    expect(lifecycleReceipts.size).toBe(before + 2)
    const repeated = await createAgent(identity, 'Tengri', operationId)
    expect(repeated.runtimeEpoch).toBe(agent.runtimeEpoch)
    expect(lifecycleReceipts.size).toBe(before + 2)
  })

  test('reports quota exhaustion before creation and reuses the reservation ID on retry', async () => {
    const { createAgent } = client
    const operationId = randomUUID()
    const before = lifecycleReceipts.size
    const previousRequest = receivedRequest
    const failures = { code: grpc.status.RESOURCE_EXHAUSTED, operationIds: [] as string[] }
    reservationFailure = failures
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expectFailure(createAgent(identity, 'Quota retry', operationId), {
          status: 429,
          code: 'capacity_full',
          message:
            'Workspace capacity is full for this account or the platform. Delete an unused workspace or ask an administrator to adjust your quota, then retry.',
        })
      }
      expect(failures.operationIds).toHaveLength(2)
      expect(failures.operationIds[0]).toMatch(/^[0-9a-f-]{36}$/)
      expect(failures.operationIds[1]).toBe(failures.operationIds[0])
      expect(lifecycleReceipts.size).toBe(before)
      expect(receivedRequest).toBe(previousRequest)
    } finally {
      reservationFailure = undefined
    }
    expect((await createAgent(identity, 'Quota retry', operationId)).phase).toBe('ready')
    expect(receivedRequest).toEqual({ displayName: 'Quota retry', reservationId: operationId })
    expect(lifecycleReceipts.size).toBe(before + 2)
  })

  test.each([
    [grpc.status.PERMISSION_DENIED, 403],
    [grpc.status.UNAVAILABLE, 503],
  ])('keeps non-quota reservation failures distinct: %s', async (code, status) => {
    const before = lifecycleReceipts.size
    const previousRequest = receivedRequest
    reservationFailure = { code, operationIds: [] }
    try {
      const failure = await rejection(client.createAgent(identity, 'Failed reservation', randomUUID()))
      expect(failure).toMatchObject({ status })
      expect(failure).not.toHaveProperty('code', 'capacity_full')
      expect(lifecycleReceipts.size).toBe(before)
      expect(receivedRequest).toBe(previousRequest)
    } finally {
      reservationFailure = undefined
    }
  })

  test('retires an expired creation ID so a new reservation can be submitted', async () => {
    await expectFailure(client.createAgent(identity, 'Expired reservation', randomUUID()), {
      status: 409,
      code: 'lifecycle_superseded',
    })
  })

  test.each(['Released reservation', 'Deleting workspace'])(
    'retires a recovered creation after removal: %s',
    async (displayName) => {
      const { createAgent } = client
      const operationId = randomUUID()
      await expectFailure(createAgent(identity, displayName, operationId), {
        status: 409,
        code: 'lifecycle_superseded',
      })
      const count = lifecycleReceipts.size
      await expectFailure(createAgent(identity, displayName, operationId), {
        status: 409,
        code: 'lifecycle_superseded',
      })
      expect(lifecycleReceipts.size).toBe(count)
      expect((await createAgent(identity, 'New creation', randomUUID())).displayName).toBe('New creation')
    },
  )

  test('keeps individual policy and controller requests bounded during lifecycle polling', async () => {
    const started = Date.now()
    expect((await client.resumeAgent(identity, agentId, workspaceUid, randomUUID())).id).toBe('agent-test')
    expect(receivedCommandDeadline).toBeLessThanOrEqual(Date.now() + 30_000)
    expect(receivedCommandDeadline).toBeGreaterThan(started)
  })

  test('waits for the controller to observe the committed version before acknowledging an already ready guest', async () => {
    const reads = agentReads
    delayedRuntimeReads = 2
    const agent = await client.resumeAgent(identity, agentId, workspaceUid, randomUUID())
    expect(agentReads - reads).toBe(4)
    expect(agent.policyVersion).toBe(String(lifecycleVersion))
  })

  test('rejects a superseded resume receipt after a later sleep and new epoch without executing it again', async () => {
    const { resumeAgent, sleepAgent } = client
    const originalId = randomUUID()
    const original = await resumeAgent(identity, agentId, workspaceUid, originalId)
    await sleepAgent(identity, agentId, workspaceUid, randomUUID())
    const next = await resumeAgent(identity, agentId, workspaceUid, randomUUID())
    expect(next.runtimeEpoch).not.toBe(original.runtimeEpoch)
    const count = lifecycleReceipts.size
    await expectFailure(resumeAgent(identity, agentId, workspaceUid, originalId), {
      status: 409,
      code: 'lifecycle_superseded',
    })
    expect(lifecycleReceipts.size).toBe(count)
  })

  test('does not acknowledge sleep when reconciliation has already observed a newer resume', async () => {
    supersedeRuntimeCommand = true
    await expectFailure(client.sleepAgent(identity, agentId, workspaceUid, randomUUID()), {
      status: 409,
      code: 'lifecycle_superseded',
    })
    expect(runtimePhase).toBe('AGENT_PHASE_READY')
  })

  test('accepts a newer observed version when the requested epoch and phase still match', async () => {
    const { resumeAgent } = client
    const operationId = randomUUID()
    const original = await resumeAgent(identity, agentId, workspaceUid, operationId)
    runtimePolicyVersion = ++lifecycleVersion
    const recovered = await resumeAgent(identity, agentId, workspaceUid, operationId)
    expect(recovered.runtimeEpoch).toBe(original.runtimeEpoch)
    expect(recovered.phase).toBe('ready')
  })

  test('recovers a committed runtime command after the reply is lost and rejects a changed external payload', async () => {
    const { createAgent, sleepAgent } = client
    const before = lifecycleReceipts.size
    loseCommandResponse = true
    await sleepAgent(identity, agentId, workspaceUid, randomUUID())
    expect(lifecycleReceipts.size).toBe(before + 1)
    const operationId = randomUUID()
    await createAgent(identity, 'Original name', operationId)
    const count = lifecycleReceipts.size
    await expectFailure(createAgent(identity, 'Changed name', operationId), { status: 409 })
    expect(lifecycleReceipts.size).toBe(count)
    expect(runtimeDisplayName).toBe('Original name')
  })

  test('deletes a failed workspace after observing its committed stop', async () => {
    const { createAgent, deleteAgent } = client
    await createAgent(identity, 'Failed deletion fixture', randomUUID())
    runtimePhase = 'AGENT_PHASE_FAILED'
    delayedRuntimeReads = 2
    const reads = agentReads
    try {
      await deleteAgent(identity, agentId, workspaceUid, randomUUID())
      expect(agentReads - reads).toBe(4)
      expect(removedAgent).toBe(true)
    } finally {
      delayedRuntimeReads = 0
      staleAgents.length = 0
      runtimePhase = 'AGENT_PHASE_READY'
      removedAgent = false
    }
  })

  test('rejects a failed stop after the controller observes its committed version', async () => {
    const { createAgent, deleteAgent } = client
    await createAgent(identity, 'Failed stop fixture', randomUUID())
    staleAgents.push(runtimeAgent('agent-test'), {
      ...runtimeAgent('agent-test'),
      phase: 'AGENT_PHASE_FAILED',
      policyVersion: String(lifecycleVersion + 1),
    })
    try {
      await expectFailure(deleteAgent(identity, agentId, workspaceUid, randomUUID()), {
        status: 503,
      })
      expect(removedAgent).toBe(false)
    } finally {
      staleAgents.length = 0
      runtimePhase = 'AGENT_PHASE_READY'
    }
  })

  test('recovers deletion after the controller has removed the workspace without requiring its metadata', async () => {
    const { createAgent, deleteAgent } = client
    await createAgent(identity, 'Delete fixture', randomUUID())
    const operationId = randomUUID()
    await deleteAgent(identity, agentId, workspaceUid, operationId)
    const count = lifecycleReceipts.size
    const reads = agentReads
    await deleteAgent(identity, agentId, workspaceUid, operationId)
    expect(lifecycleReceipts.size).toBe(count)
    expect(agentReads).toBe(reads)
    removedAgent = false
  })

  test('waits for confirmed cleanup on fresh and recovered deletion requests', async () => {
    const { createAgent, deleteAgent } = client
    await createAgent(identity, 'Pending cleanup', randomUUID())
    const operationId = randomUUID()
    try {
      for (const recovered of [false, true]) {
        cleanupComplete = false
        const checked = new Promise<void>((resolve) => {
          removalCheck = resolve
        })
        let settled = false
        const deletion = deleteAgent(identity, agentId, workspaceUid, operationId).then(() => {
          settled = true
        })
        await checked
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(settled).toBe(false)
        const commands = lifecycleReceipts.size
        const reads = agentReads
        cleanupComplete = true
        await deletion
        expect(settled).toBe(true)
        expect(lifecycleReceipts.size).toBe(commands)
        if (recovered) expect(agentReads).toBe(reads)
      }
    } finally {
      cleanupComplete = true
      removalCheck = undefined
      removedAgent = false
    }
  })

  test('retains the deletion operation when cleanup status is unavailable', async () => {
    const { createAgent, deleteAgent } = client
    await createAgent(identity, 'Unavailable cleanup', randomUUID())
    const operationId = randomUUID()
    try {
      cleanupUnavailable = true
      await expectFailure(deleteAgent(identity, agentId, workspaceUid, operationId), {
        status: 503,
      })
      const commands = lifecycleReceipts.size
      cleanupUnavailable = false
      await deleteAgent(identity, agentId, workspaceUid, operationId)
      expect(lifecycleReceipts.size).toBe(commands)
    } finally {
      cleanupUnavailable = false
      removedAgent = false
    }
  })

  test('serves only verified retained image attachments through the signed file contract', async () => {
    const { readCodexAttachment, readWorkspaceImage } = client
    const prefix = '/workspace/.tengri-attachments/11111111-1111-4111-8111-111111111111'
    const image = await readCodexAttachment(identity, 'agent-test', `${prefix}.png`)
    expect(receivedRequest).toMatchObject({
      path: '/workspace/.tengri-attachments/11111111-1111-4111-8111-111111111111.png',
    })
    expect(image.mediaType).toBe('image/png')
    expect((await readWorkspaceImage(identity, 'agent-test', '/workspace/chart.png')).mediaType).toBe('image/png')
    expect(receivedRequest).toMatchObject({ path: '/workspace/chart.png' })
    await expectFailure(readWorkspaceImage(identity, 'agent-test', '/etc/private.png'), {
      status: 400,
    })
    expect(Array.from(image.content)).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    await expectFailure(readCodexAttachment(identity, 'agent-test', `${prefix}.jpg`), { status: 415 })
    await expectFailure(readCodexAttachment(identity, 'agent-test', '/workspace/private.png'), {
      status: 400,
    })
    await expectFailure(readCodexAttachment(identity, 'agent-test', '/workspace/.tengri-attachments/../private.png'), {
      status: 400,
    })
  })

  test('rejects non-UTF-8 files instead of corrupting their bytes', async () => {
    const error = await rejection(client.readFile(identity, 'agent-test', '/workspace/binary'))

    expect(error).toMatchObject({
      message: 'This file is not valid UTF-8 text',
      status: 415,
    })
  })

  test('persists power settings through the signed gRPC contract, including disabled automatic sleep', async () => {
    const agent = await client.updatePowerSettings(identity, 'agent-test', {
      idleTimeoutMinutes: 0,
    })
    expect(receivedRequest).toEqual({
      id: 'agent-test',
      idleTimeoutMinutes: 0,
      _idleTimeoutMinutes: 'idleTimeoutMinutes',
    })
    expect(agent.power).toEqual({ idleTimeoutMinutes: 0 })
    expect(metadataContext().sessionId).toBe(identity.session.id)
    expectSignedRequest('UpdatePowerSettings')
  })

  test('does not report a saved timeout after automatic sleep has committed', async () => {
    await expectFailure(client.updatePowerSettings(identity, 'sleep-committed', { idleTimeoutMinutes: 60 }), {
      status: 409,
      message: 'The agent has started sleeping. Resume it, then change this setting.',
    })
  })

  test('reports uncertain runtime readiness as unavailable without inventing a failed agent', async () => {
    const { listAgents } = client
    const previousPhase = runtimePhase
    runtimePhase = 'AGENT_PHASE_READY'
    runtimeConditions = [{ type: 'Ready', status: 'Unknown', reason: 'ReconcileUnavailable' }]
    try {
      await expectFailure(listAgents(identity), {
        status: 503,
        message: 'Runtime status cannot be confirmed. Retrying.',
      })
      runtimeConditions = []
      expect((await listAgents(identity))[0]?.phase).toBe('ready')
    } finally {
      runtimeConditions = []
      runtimePhase = previousPhase
    }
  })

  test('rejects an old runtime response rather than inventing its power settings', async () => {
    await expectFailure(client.createAgent(identity, 'Old runtime', randomUUID()), {
      status: 503,
      message: 'The runtime returned invalid power settings. Update Tengri and refresh.',
    })
  })

  test('verifies file content revisions and rejects a mismatched read receipt', async () => {
    const { readFile } = client
    const result = await readFile(identity, 'agent-test', '/workspace/revision.txt')
    expect(result).toMatchObject({
      content: 'versioned content\n',
      revision: createHash('sha256').update('versioned content\n').digest('hex'),
    })
    await expectFailure(readFile(identity, 'agent-test', '/workspace/wrong-revision.txt'), {
      status: 503,
    })
  })

  test('signs the file precondition and refuses unconfirmed save receipts', async () => {
    const { writeFile } = client
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
    expectSignedRequest('WriteFile')
    await expectFailure(writeFile(identity, 'agent-test', '/workspace/unconfirmed.txt', content, expectedRevision), {
      status: 503,
    })
    await expectFailure(writeFile(identity, 'agent-test', '/workspace/revision.txt', content, '0'.repeat(64)), {
      status: 409,
      code: 'file_conflict',
    })
    await expectFailure(writeFile(identity, 'agent-test', '/workspace/revision.txt', content, ''), {
      status: 400,
    })
  })

  test('preserves bounded file-search metadata from the control plane', async () => {
    const result = await client.searchFiles(identity, 'agent-test', '/workspace', 'main')

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
    const session = await client.issuePreviewSession(identity, 'agent-test', 4321, '/app?mode=dev', '#editor')

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
    const { watchFiles } = client
    const stream = await watchFiles(identity, 'agent-test', '/workspace')
    stream.resume()
    await finished(stream, { cleanup: true })

    expect(receivedRequest).toMatchObject({ agentId: 'agent-test', path: '/workspace' })
    expect(receivedRequest).not.toHaveProperty('afterSequence')
    expect(receivedRequest?._afterSequence).toBeUndefined()
    const method = runtimeService.WatchFiles
    const initialBody = method.requestSerialize({ agentId: 'agent-test', path: '/workspace' })
    const explicitZeroBody = method.requestSerialize({ agentId: 'agent-test', path: '/workspace', afterSequence: 0 })
    expect(explicitZeroBody.equals(initialBody)).toBeFalse()

    expect(metadataValue('x-tengri-signature')).toBe(expectedSignature(method, receivedRequest ?? {}))

    const resumed = await watchFiles(identity, 'agent-test', '/workspace', 0)
    resumed.resume()
    await finished(resumed, { cleanup: true })
    expect(receivedRequest).toMatchObject({
      agentId: 'agent-test',
      path: '/workspace',
      afterSequence: '0',
      _afterSequence: 'afterSequence',
    })
    expect(metadataValue('x-tengri-signature')).toBe(expectedSignature(method, receivedRequest ?? {}))
  })

  test('projects terminal creation identity and cancels gRPC when the browser request aborts', async () => {
    const { createTerminal } = client
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

    await expectRpcCancellation(
      (signal) => createTerminal(identity, 'agent-test', 'terminal-creation-cancel', '/workspace', 120, 32, signal),
      5_000,
      1_000,
    )
  })

  test('cancels Codex account gRPC when the browser request aborts', async () => {
    await expectRpcCancellation(
      (signal) => client.getCodexAccount(identity, 'codex-account-cancel', signal),
      5_000,
      1_000,
    )
  })

  test.each(['active runs', 'run status'] as const)('cancels %s gRPC when the browser request aborts', async (kind) => {
    await expectRpcCancellation(
      (signal) =>
        kind === 'active runs'
          ? client.getActiveCodexRuns(identity, 'codex-run-read-cancel', 'thread-selected', signal)
          : client.getCodexRun(identity, 'codex-run-read-cancel', '11111111-1111-4111-8111-111111111111', signal),
      500,
      500,
    )
  })

  test('cancels the model catalog gRPC when the browser request aborts', async () => {
    await expectRpcCancellation(
      (signal) => client.listCodexModels(identity, 'catalog-cancel', undefined, signal),
      300,
      300,
    )
  })

  test('restores an active Codex device login without creating another attempt', async () => {
    const { getCodexLogin } = client
    expect(await getCodexLogin(identity, 'agent-test')).toEqual({
      loginId: 'login-one',
      verificationUrl: 'https://auth.openai.com/device',
      userCode: 'TENG-RI01',
      expiresAt: '2026-08-31T09:15:00Z',
    })
    expect(await getCodexLogin(identity, 'no-active-login')).toBeNull()
  })

  test('preserves a leading UTF-8 BOM for lossless editor round trips', async () => {
    const file = await client.readFile(identity, 'agent-test', '/workspace/bom.txt')

    expect(file.content).toBe('\ufeffhello')
  })

  test('rejects legacy key bundles and reads a replaced single key for the next request', async () => {
    const { getAgent, updatePowerSettings } = client
    process.env.TENGRI_INTERNAL_HMAC_SECRET = `${secret},${secret}`
    try {
      await expectFailure(getAgent(identity, 'agent-test'), { status: 503 })
      process.env.TENGRI_INTERNAL_HMAC_SECRET = '6e'.repeat(32)
      await updatePowerSettings(identity, 'agent-test', { idleTimeoutMinutes: 60 })
      expect(receivedMetadata?.get('x-tengri-signature-previous')).toEqual([])
      expect(receivedMetadata?.get('x-tengri-subject')).toEqual([])
      expect(receivedMetadata?.get('x-tengri-timestamp')).toEqual([])
      expect(metadataValue('x-tengri-signature')).toBe(
        expectedSignature(
          runtimeService.UpdatePowerSettings,
          { id: 'agent-test', idleTimeoutMinutes: 60 },
          '6e'.repeat(32),
        ),
      )
    } finally {
      process.env.TENGRI_INTERNAL_HMAC_SECRET = secret
    }
  })

  test('sends validated user answers separately from approval decisions', async () => {
    const response = { answers: { environment: { answers: ['Staging'] } } }
    await client.answerCodexQuestions(
      identity,
      'agent-test',
      'question-1',
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      response,
    )
    if (!receivedRequest) throw new Error('The question response did not reach the gRPC server')
    expect(receivedRequest.agentId).toBe('agent-test')
    expect(receivedRequest.approvalId).toBe('question-1')
    expect(receivedRequest.decision).toBe('CODEX_APPROVAL_DECISION_UNSPECIFIED')
    expect(JSON.parse(Buffer.from(receivedRequest.responseJson as Uint8Array).toString())).toEqual(response)
  })

  test('preserves structured command approval decisions across gRPC', async () => {
    const runId = '11111111-1111-4111-8111-111111111111'
    const operationId = '22222222-2222-4222-8222-222222222222'
    for (const [approvalId, decision, wireDecision] of [
      ['approval-1', 'approve-exec-policy-amendment', 'CODEX_APPROVAL_DECISION_APPROVE_EXEC_POLICY_AMENDMENT'],
      ['approval-2', 'approve-network-policy-amendment', 'CODEX_APPROVAL_DECISION_APPROVE_NETWORK_POLICY_AMENDMENT'],
    ] as const) {
      await client.resolveCodexApproval(identity, 'agent-test', approvalId, runId, operationId, decision)
      expect(receivedRequest).toEqual({
        agentId: 'agent-test',
        approvalId,
        runId,
        operationId,
        decision: wireDecision,
        responseJson: Buffer.alloc(0),
      })
    }
  })

  test('identifies an incompatible retained guest as requiring a runtime upgrade', async () => {
    await expectFailure(client.listCodexModels(identity, 'retained-runtime-upgrade'), {
      message: 'This workspace needs a runtime upgrade before it can reconnect.',
      status: 412,
      code: 'runtime_upgrade_required',
    })
  })

  test('preserves the atomic event cursor returned with a resumed thread snapshot', async () => {
    const thread = await restoredThread('thread-test')
    expect(receivedRequest).toEqual({ agentId: 'agent-test', threadId: 'thread-test' })
    expect(thread).toEqual({
      id: 'thread-test',
      rawJson: '{"thread":{"id":"thread-test","historyMode":"paginated","turns":[]}}',
      eventSequence: 42,
      itemEventSequences: {},
    })
  })

  test('serves generated image bytes through the authorized native history read', async () => {
    const { readCodexGeneratedImage } = client
    const path = '/home/nanoagent/.codex/generated_images/thread-generated/exec-cat.png'
    const image = await readCodexGeneratedImage(identity, 'agent-test', path, new AbortController().signal)
    expect(image.mediaType).toBe('image/png')
    expect(image.content.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(receivedRequest).toEqual({ agentId: 'agent-test', threadId: 'thread-generated' })
    await expectFailure(
      readCodexGeneratedImage(identity, 'agent-test', path.replace('exec-cat', 'other'), new AbortController().signal),
      { status: 404 },
    )
    await expectFailure(
      readCodexGeneratedImage(identity, 'agent-test', '/home/nanoagent/.codex/auth.json', new AbortController().signal),
      { status: 400 },
    )
  })

  test('rejects an invalid event cursor returned with a thread snapshot', async () => {
    await expectFailure(client.resumeCodexThread(identity, 'agent-test', 'invalid-sequence'), {
      message: 'Tengri control plane returned an invalid Codex event cursor',
      status: 502,
      code: 'conversation_history_invalid',
    })
  })

  test('preserves item page cursors and rejects pages older than the recovery baseline', async () => {
    expect(await restoredThread('paged-thread')).toMatchObject({
      eventSequence: 42,
      itemEventSequences: { 'message-1': 52 },
    })
    await expectFailure(restoredThread('outdated-item-cursor'), {
      message: 'Codex conversation recovery returned invalid history: invalid event cursor',
    })
  })

  test('identifies only the guest missing-conversation response as recoverable with a new conversation', async () => {
    const { resumeCodexThread } = client

    await expectFailure(resumeCodexThread(identity, 'agent-test', 'missing-conversation'), {
      message: 'Codex conversation could not be found',
      status: 404,
      code: 'conversation_not_found',
    })
    await expectFailure(resumeCodexThread(identity, 'agent-test', 'missing-resource'), {
      message: 'Tengri resource was not found',
      status: 404,
      code: undefined,
    })
    await expectFailure(resumeCodexThread(identity, 'agent-test', 'unavailable-conversation'), {
      message: 'Tengri control plane is unavailable',
      status: 503,
      code: undefined,
    })
  })

  test('keeps a conversation resume conflict retryable without exposing guest details', async () => {
    await expectFailure(client.resumeCodexThread(identity, 'agent-test', 'conflicted-conversation'), {
      message: 'The conversation changed while loading. Reconnecting…',
      status: 503,
      code: undefined,
    })
    expect(await restoredThread('conflicted-conversation')).toMatchObject({ id: 'conflicted-conversation' })
    expect(conflictedConversationResumes).toBe(2)
  })

  test('sanitizes upstream failures and treats verifier failures as service errors', async () => {
    const { getAgent } = client
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
  const { resumeCodexThread } = client
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
    'tengri.ofz.v2',
    metadataValue('x-tengri-audience'),
    method.path,
    createHash('sha256').update(method.requestSerialize(body)).digest('hex'),
    metadataValue('x-tengri-nonce'),
    value.toString('base64url'),
    metadataValue('x-tengri-recovery-generation'),
  ].join('\n')
  return createHmac('sha256', Buffer.from(key, 'hex')).update(payload).digest('hex')
}

function expectSignedRequest(method: string) {
  if (!receivedRequest) throw new Error(`Fixture did not receive ${method}`)
  expect(metadataValue('x-tengri-signature')).toBe(expectedSignature(runtimeService[method], receivedRequest))
}

async function expectFailure(request: Promise<unknown>, expected: Record<string, unknown>) {
  expect(await rejection(request)).toMatchObject(expected)
}
