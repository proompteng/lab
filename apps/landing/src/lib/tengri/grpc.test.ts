import { createHash, createHmac, randomUUID } from 'node:crypto'
import { create, fromBinary } from '@bufbuild/protobuf'
import { RequestContextSchema, SessionSchema } from '../generated/proompteng/authz/v1/authz_pb'
import type { TengriIdentity } from './auth'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { createSpiffeFixture } from '../platform/spiffe.fixture'
import { codexModelFixtures } from '../../components/tengri/codex-models.fixture'

void mock.module('server-only', () => ({}))
const { verifySpiffePeer } = await import('../platform/spiffe')

const secret = '68'.repeat(32)
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
let receiverAudience = '77777777-7777-4777-8777-777777777777'
let receiverGuestApiProtocolVersion = 9
let fileWriteCalls = 0
let terminalRequestStarted: (() => void) | null = null
let terminalRequestCancelled: (() => void) | null = null
let editorRequestStarted: (() => void) | null = null
let editorRequestCancelled: (() => void) | null = null
let catalogRequestStarted: (() => void) | null = null
let catalogRequestCancelled: (() => void) | null = null
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
      authz: { v1: { TengriAuthorizationService: grpc.ServiceClientConstructor & { service: grpc.ServiceDefinition } } }
    }
  }
  ofzServer = new grpc.Server()
  ofzServer.addService(authzDescriptor.proompteng.authz.v1.TengriAuthorizationService.service, {
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
    executeCommand(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
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
    getRequestAudience(
      _call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      callback(null, { audience: receiverAudience, guestApiProtocolVersion: receiverGuestApiProtocolVersion })
    },
    issueEditorSession(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      receivedMetadata = call.metadata
      receivedRequest = call.request
      if (call.request.windowId === 'desktop-editor-cancel') {
        editorRequestStarted?.()
        const timer = setTimeout(
          () => callback(serviceError(grpc.status.DEADLINE_EXCEEDED, 'editor launch was not cancelled'), null),
          5_000,
        )
        call.on('cancelled', () => {
          clearTimeout(timer)
          editorRequestCancelled?.()
        })
        return
      }
      callback(null, {
        id: 'a'.repeat(24),
        launchUrl: 'https://tengri.example/v1/preview/open#lease',
        previewOrigin: `https://tengri-${'a'.repeat(24)}.example`,
        expiresAt: '2026-09-09T00:00:00Z',
      })
    },
    issueBrowserSession(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      receivedMetadata = call.metadata
      receivedRequest = call.request
      callback(null, {
        id: 'b'.repeat(24),
        launchUrl: 'https://tengri.example/v1/preview/open#lease',
        previewOrigin: `https://tengri-${'b'.repeat(24)}.example`,
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
    listAgents(
      _call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      callback(null, { agents: [runtimeAgent('agent-test')] })
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
    terminateTerminal(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      receivedTerminalDeadlines.set('termination', Number(call.getDeadline()))
      if (call.request.terminalId === 'terminal-compound-cancel') {
        terminalRequestStarted?.()
        const timer = setTimeout(
          () => callback(serviceError(grpc.status.DEADLINE_EXCEEDED, 'terminal request was not cancelled'), null),
          1_000,
        )
        call.on('cancelled', () => {
          clearTimeout(timer)
          terminalRequestCancelled?.()
        })
        return
      }
      callback(null, {})
    },
    issueTerminalTicket(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      receivedTerminalDeadlines.set('ticket', Number(call.getDeadline()))
      if (call.request.terminalId === 'terminal-compound-cancel') {
        terminalRequestStarted?.()
        const timer = setTimeout(
          () => callback(serviceError(grpc.status.DEADLINE_EXCEEDED, 'terminal request was not cancelled'), null),
          1_000,
        )
        call.on('cancelled', () => {
          clearTimeout(timer)
          terminalRequestCancelled?.()
        })
        return
      }
      callback(null, {
        websocketUrl: 'wss://tengri.example/v1/terminal/ws',
        ticket: 'fixture-ticket',
        expiresAt: '2026-10-18T12:00:00Z',
      })
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
        catalogRequestStarted?.()
        const timer = setTimeout(
          () => callback(serviceError(grpc.status.DEADLINE_EXCEEDED, 'catalog request was not cancelled'), null),
          2_000,
        )
        call.on('cancelled', () => {
          clearTimeout(timer)
          catalogRequestCancelled?.()
        })
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
      callback(null, {
        runId: call.request.operationId,
        agentId: call.request.agentId,
        threadId: call.request.threadId,
        stateJson: JSON.stringify({ phase: 'running', turnId: 'turn-selected' }),
      })
    },
    getActiveCodexRun(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      receivedMetadata = call.metadata
      receivedRequest = call.request
      callback(
        null,
        call.request.id === 'agent-empty'
          ? {}
          : {
              runId: '11111111-1111-4111-8111-111111111111',
              agentId: call.request.id,
              threadId: 'thread-selected',
              stateJson: JSON.stringify({ phase: 'running', turnId: 'turn-selected' }),
            },
      )
    },
    getCodexRun(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      receivedMetadata = call.metadata
      receivedRequest = call.request
      callback(null, {
        runId: call.request.runId,
        agentId: call.request.agentId,
        threadId: 'thread-selected',
        stateJson: JSON.stringify({ phase: 'running', turnId: 'turn-selected' }),
      })
    },
    steerCodexInput(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      if (call.request.text === 'not-dispatched') {
        callback(serviceError(grpc.status.FAILED_PRECONDITION, 'Codex control was not dispatched'), null)
        return
      }
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
    writeFile(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
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
      if (call.request.path === '/workspace/renewal') renewingFileWatch = call
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
  test('identifies a recorded control that was rejected before native dispatch', async () => {
    const { steerCodexTurn } = await import('./grpc')
    expect(
      await rejection(
        steerCodexTurn(
          identity,
          'agent-test',
          'thread-selected',
          'turn-selected',
          '22222222-2222-4222-8222-222222222222',
          '11111111-1111-4111-8111-111111111111',
          'not-dispatched',
        ),
      ),
    ).toMatchObject({ status: 409, code: 'control_not_dispatched' })
  })
  test('recovers the server-owned active run and distinguishes an empty workspace', async () => {
    const { getActiveCodexRun } = await import('./grpc')
    expect(await getActiveCodexRun(identity, 'agent-test')).toEqual({
      runId: '11111111-1111-4111-8111-111111111111',
      agentId: 'agent-test',
      threadId: 'thread-selected',
      state: { phase: 'running', turnId: 'turn-selected' },
    })
    expect(receivedRequest).toEqual({ id: 'agent-test' })
    expect(await getActiveCodexRun(identity, 'agent-empty')).toBeNull()
  })
  test('reads the current receiver audience for every request and rejects malformed bindings before submission', async () => {
    const { listCodexModels } = await import('./grpc')
    try {
      await listCodexModels(identity, 'agent-test')
      expect(metadataValue('x-tengri-audience')).toBe(receiverAudience)
      receiverAudience = '88888888-8888-4888-8888-888888888888'
      await listCodexModels(identity, 'agent-test')
      expect(metadataValue('x-tengri-audience')).toBe(receiverAudience)
      receiverAudience = 'not-an-audience'
      const before = receivedRequest
      expect(await rejection(listCodexModels(identity, 'agent-test'))).toMatchObject({
        message: 'Tengri request audience is invalid',
        status: 503,
      })
      expect(receivedRequest).toBe(before)
    } finally {
      receiverAudience = '77777777-7777-4777-8777-777777777777'
    }
  })
  test('accepts guest API 9 before sending canonical file writes', async () => {
    const { writeFile } = await import('./grpc')
    const before = fileWriteCalls
    const previous = receiverGuestApiProtocolVersion
    try {
      receiverGuestApiProtocolVersion = 9
      await writeFile(identity, 'agent-test', '/workspace/main.ts', 'protected', 'missing')
      expect(fileWriteCalls).toBe(before + 1)
    } finally {
      receiverGuestApiProtocolVersion = previous
    }
  })

  test('refuses incompatible controllers before sending canonical file writes', async () => {
    const { writeFile } = await import('./grpc')
    const before = fileWriteCalls
    try {
      for (const version of [0, 4, 5, 6, 7, 8, 10]) {
        receiverGuestApiProtocolVersion = version
        expect(
          await rejection(writeFile(identity, 'agent-test', '/workspace/main.ts', 'protected', 'missing')),
        ).toMatchObject({ status: 503 })
        expect(fileWriteCalls).toBe(before)
      }
    } finally {
      receiverGuestApiProtocolVersion = 9
    }
    await writeFile(identity, 'agent-test', '/workspace/main.ts', 'protected', 'missing')
    expect(fileWriteCalls).toBe(before + 1)
  })

  test('renews the client certificate while an existing signed stream stays open', async () => {
    const { listCodexModels, watchFiles } = await import('./grpc')
    const watch = await watchFiles(identity, 'agent-test', '/workspace/renewal')
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
    renewingFileWatch?.write({ sequence: '2', kind: 'FILE_EVENT_KIND_RESET', path: '/workspace/renewal' })
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
    expect(metadataContext().deadlineUnixMs).toBeLessThanOrEqual(BigInt(Date.now() - 250 + 5000))
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
    const { sendCodexTurn, steerCodexTurn } = await import('./grpc')
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

  test('treats missing model RPCs and invalid catalogs as failures without negotiating guest capabilities', async () => {
    const { listCodexModels } = await import('./grpc')
    expect(await rejection(listCodexModels(identity, 'unimplemented-catalog'))).toMatchObject({
      status: 503,
      code: undefined,
    })
    expect(await rejection(listCodexModels(identity, 'broken-catalog'))).toMatchObject({
      status: 502,
      code: 'model_catalog_invalid',
    })
  })

  test('revokes desktop previews for the authenticated subject without a caller-selected owner', async () => {
    const { revokeDesktopPreviews } = await import('./grpc')
    await revokeDesktopPreviews(identity)
    expect(receivedRequest).toEqual({})
    expect(metadataContext().sessionId).toBe(identity.session.id)
    expect(metadataValue('x-tengri-signature')).not.toBe('')
  })

  test('signs browser renewal with its exact agent and desktop window identity', async () => {
    const { issueBrowserSession } = await import('./grpc')
    const session = await issueBrowserSession(
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
    const { issueEditorSession, revokePreviewSession } = await import('./grpc')
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
    const { issueEditorSession } = await import('./grpc')
    const started = new Promise<void>((resolve) => {
      editorRequestStarted = resolve
    })
    const cancelled = new Promise<void>((resolve) => {
      editorRequestCancelled = resolve
    })
    const controller = new AbortController()
    const pending = issueEditorSession(identity, 'agent-test', 'desktop-editor-cancel', false, controller.signal).catch(
      (error: unknown) => error,
    )
    try {
      await started
      controller.abort()
      const result = await Promise.race([
        pending,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Editor cancellation timed out')), 300)),
      ])
      expect(result).toMatchObject({ name: 'AbortError', message: 'Tengri request was canceled' })
      await Promise.race([
        cancelled,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Editor RPC was not cancelled')), 1_000)),
      ])
    } finally {
      editorRequestStarted = null
      editorRequestCancelled = null
    }
  })

  test('keeps compound terminal calls within the shared guest-operation budget', async () => {
    const { terminateTerminal, issueTerminalTicket } = await import('./grpc')
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
      const client = await import('./grpc')
      const started = new Promise<void>((resolve) => {
        terminalRequestStarted = resolve
      })
      const cancelled = new Promise<void>((resolve) => {
        terminalRequestCancelled = resolve
      })
      const controller = new AbortController()
      const pending = client[method](identity, 'agent-test', 'terminal-compound-cancel', controller.signal).catch(
        (error: unknown) => error,
      )
      try {
        await started
        controller.abort()
        const result = await Promise.race([
          pending,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Terminal cancellation timed out')), 300),
          ),
        ])
        expect(result).toMatchObject({ name: 'AbortError', message: 'Tengri request was canceled' })
        await Promise.race([
          cancelled,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Terminal RPC was not cancelled')), 1_000),
          ),
        ])
      } finally {
        terminalRequestStarted = null
        terminalRequestCancelled = null
      }
    },
  )

  test('creates a workspace when the Ofz database clock trails the BFF by one second', async () => {
    const { createAgent } = await import('./grpc')
    ofzDatabaseClockOffsetMs = 1000
    try {
      expect(await createAgent(identity, 'Tengri', randomUUID())).toMatchObject({ id: 'agent-test', phase: 'ready' })
    } finally {
      ofzDatabaseClockOffsetMs = 0
    }
  })

  test('reserves capacity before creation and starts the enrolled UID with a durable Ofz command', async () => {
    const { createAgent } = await import('./grpc')
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
    const { createAgent } = await import('./grpc')
    const { lifecycleId } = await import('./lifecycle-command')
    const operationId = randomUUID()
    const before = lifecycleReceipts.size
    const previousRequest = receivedRequest
    const failures = { code: grpc.status.RESOURCE_EXHAUSTED, operationIds: [] as string[] }
    reservationFailure = failures
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(await rejection(createAgent(identity, 'Quota retry', operationId))).toMatchObject({
          status: 429,
          code: 'capacity_full',
          message:
            'Workspace capacity is full for this account or the platform. Delete an unused workspace or ask an administrator to adjust your quota, then retry.',
        })
      }
      expect(failures.operationIds).toEqual([
        lifecycleId(identity, operationId, 'reserve'),
        lifecycleId(identity, operationId, 'reserve'),
      ])
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
    const { createAgent } = await import('./grpc')
    const before = lifecycleReceipts.size
    const previousRequest = receivedRequest
    reservationFailure = { code, operationIds: [] }
    try {
      const failure = await rejection(createAgent(identity, 'Failed reservation', randomUUID()))
      expect(failure).toMatchObject({ status })
      expect(failure).not.toHaveProperty('code', 'capacity_full')
      expect(lifecycleReceipts.size).toBe(before)
      expect(receivedRequest).toBe(previousRequest)
    } finally {
      reservationFailure = undefined
    }
  })

  test('retires an expired creation ID so a new reservation can be submitted', async () => {
    const { createAgent } = await import('./grpc')
    expect(await rejection(createAgent(identity, 'Expired reservation', randomUUID()))).toMatchObject({
      status: 409,
      code: 'lifecycle_superseded',
    })
  })

  test.each(['Released reservation', 'Deleting workspace'])(
    'retires a recovered creation after removal: %s',
    async (displayName) => {
      const { createAgent } = await import('./grpc')
      const operationId = randomUUID()
      expect(await rejection(createAgent(identity, displayName, operationId))).toMatchObject({
        status: 409,
        code: 'lifecycle_superseded',
      })
      const count = lifecycleReceipts.size
      expect(await rejection(createAgent(identity, displayName, operationId))).toMatchObject({
        status: 409,
        code: 'lifecycle_superseded',
      })
      expect(lifecycleReceipts.size).toBe(count)
      expect((await createAgent(identity, 'New creation', randomUUID())).displayName).toBe('New creation')
    },
  )

  test('keeps individual policy and controller requests bounded during lifecycle polling', async () => {
    const { resumeAgent } = await import('./grpc')
    const started = Date.now()
    expect((await resumeAgent(identity, 'agent-test', workspaceUid, randomUUID())).id).toBe('agent-test')
    expect(receivedCommandDeadline).toBeLessThanOrEqual(Date.now() + 30_000)
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

  test('deletes a failed workspace after observing its committed stop', async () => {
    const { createAgent, deleteAgent } = await import('./grpc')
    await createAgent(identity, 'Failed deletion fixture', randomUUID())
    runtimePhase = 'AGENT_PHASE_FAILED'
    delayedRuntimeReads = 2
    const reads = agentReads
    try {
      await deleteAgent(identity, 'agent-test', workspaceUid, randomUUID())
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
    const { createAgent, deleteAgent } = await import('./grpc')
    await createAgent(identity, 'Failed stop fixture', randomUUID())
    staleAgents.push(runtimeAgent('agent-test'), {
      ...runtimeAgent('agent-test'),
      phase: 'AGENT_PHASE_FAILED',
      policyVersion: String(lifecycleVersion + 1),
    })
    try {
      expect(await rejection(deleteAgent(identity, 'agent-test', workspaceUid, randomUUID()))).toMatchObject({
        status: 503,
      })
      expect(removedAgent).toBe(false)
    } finally {
      staleAgents.length = 0
      runtimePhase = 'AGENT_PHASE_READY'
    }
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

  test('waits for confirmed cleanup on fresh and recovered deletion requests', async () => {
    const { createAgent, deleteAgent } = await import('./grpc')
    await createAgent(identity, 'Pending cleanup', randomUUID())
    const operationId = randomUUID()
    try {
      for (const recovered of [false, true]) {
        cleanupComplete = false
        const checked = new Promise<void>((resolve) => {
          removalCheck = resolve
        })
        let settled = false
        const deletion = deleteAgent(identity, 'agent-test', workspaceUid, operationId).then(() => {
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
    const { createAgent, deleteAgent } = await import('./grpc')
    await createAgent(identity, 'Unavailable cleanup', randomUUID())
    const operationId = randomUUID()
    try {
      cleanupUnavailable = true
      expect(await rejection(deleteAgent(identity, 'agent-test', workspaceUid, operationId))).toMatchObject({
        status: 503,
      })
      const commands = lifecycleReceipts.size
      cleanupUnavailable = false
      await deleteAgent(identity, 'agent-test', workspaceUid, operationId)
      expect(lifecycleReceipts.size).toBe(commands)
    } finally {
      cleanupUnavailable = false
      removedAgent = false
    }
  })

  test('serves only verified retained image attachments through the signed file contract', async () => {
    const { readCodexAttachment, readWorkspaceImage } = await import('./grpc')
    const prefix = '/workspace/.tengri-attachments/11111111-1111-4111-8111-111111111111'
    const image = await readCodexAttachment(identity, 'agent-test', `${prefix}.png`)
    expect(receivedRequest).toMatchObject({
      path: '/workspace/.tengri-attachments/11111111-1111-4111-8111-111111111111.png',
    })
    expect(image.mediaType).toBe('image/png')
    expect((await readWorkspaceImage(identity, 'agent-test', '/workspace/chart.png')).mediaType).toBe('image/png')
    expect(receivedRequest).toMatchObject({ path: '/workspace/chart.png' })
    expect(await rejection(readWorkspaceImage(identity, 'agent-test', '/etc/private.png'))).toMatchObject({
      status: 400,
    })
    expect(Array.from(image.content)).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(await rejection(readCodexAttachment(identity, 'agent-test', `${prefix}.jpg`))).toMatchObject({ status: 415 })
    expect(await rejection(readCodexAttachment(identity, 'agent-test', '/workspace/private.png'))).toMatchObject({
      status: 400,
    })
    expect(
      await rejection(readCodexAttachment(identity, 'agent-test', '/workspace/.tengri-attachments/../private.png')),
    ).toMatchObject({ status: 400 })
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

  test('reports uncertain runtime readiness as unavailable without inventing a failed agent', async () => {
    const { listAgents } = await import('./grpc')
    const previousPhase = runtimePhase
    runtimePhase = 'AGENT_PHASE_READY'
    runtimeConditions = [{ type: 'Ready', status: 'Unknown', reason: 'ReconcileUnavailable' }]
    try {
      expect(await rejection(listAgents(identity))).toMatchObject({
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

  test('cancels the model catalog gRPC when the browser request aborts', async () => {
    const { listCodexModels } = await import('./grpc')
    const started = new Promise<void>((resolve) => {
      catalogRequestStarted = resolve
    })
    const cancelled = new Promise<void>((resolve) => {
      catalogRequestCancelled = resolve
    })
    const controller = new AbortController()
    const pending = listCodexModels(identity, 'catalog-cancel', undefined, controller.signal).catch(
      (error: unknown) => error,
    )
    try {
      await started
      controller.abort()
      expect(
        await Promise.race([
          pending,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Catalog cancellation timed out')), 300)),
        ]),
      ).toMatchObject({ name: 'AbortError' })
      await Promise.race([
        cancelled,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Catalog gRPC was not cancelled')), 300)),
      ])
    } finally {
      catalogRequestStarted = null
      catalogRequestCancelled = null
    }
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

  test('sends validated user answers separately from approval decisions', async () => {
    const { answerCodexQuestions } = await import('./grpc')
    const response = { answers: { environment: { answers: ['Staging'] } } }
    await answerCodexQuestions(
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
    const { resolveCodexApproval } = await import('./grpc')

    await resolveCodexApproval(
      identity,
      'agent-test',
      'approval-1',
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      'approve-exec-policy-amendment',
    )
    expect(receivedRequest).toEqual({
      agentId: 'agent-test',
      approvalId: 'approval-1',
      runId: '11111111-1111-4111-8111-111111111111',
      operationId: '22222222-2222-4222-8222-222222222222',
      decision: 'CODEX_APPROVAL_DECISION_APPROVE_EXEC_POLICY_AMENDMENT',
      responseJson: Buffer.alloc(0),
    })

    await resolveCodexApproval(
      identity,
      'agent-test',
      'approval-2',
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      'approve-network-policy-amendment',
    )
    expect(receivedRequest).toEqual({
      agentId: 'agent-test',
      approvalId: 'approval-2',
      runId: '11111111-1111-4111-8111-111111111111',
      operationId: '22222222-2222-4222-8222-222222222222',
      decision: 'CODEX_APPROVAL_DECISION_APPROVE_NETWORK_POLICY_AMENDMENT',
      responseJson: Buffer.alloc(0),
    })
  })

  test('identifies an incompatible retained guest as requiring a runtime upgrade', async () => {
    const { listCodexModels } = await import('./grpc')

    expect(await rejection(listCodexModels(identity, 'retained-runtime-upgrade'))).toMatchObject({
      message: 'This workspace needs a runtime upgrade before it can reconnect.',
      status: 412,
      code: 'runtime_upgrade_required',
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
      status: 502,
      code: 'conversation_history_invalid',
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
