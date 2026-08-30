import { createHash, createHmac } from 'node:crypto'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'

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

let server: grpc.Server
let receivedMetadata: grpc.Metadata | undefined
let receivedRequest: Record<string, unknown> | undefined
let terminalRequestStarted: (() => void) | null = null
let terminalRequestCancelled: (() => void) | null = null
let codexAccountRequestStarted: (() => void) | null = null
let codexAccountRequestCancelled: (() => void) | null = null

beforeAll(async () => {
  server = new grpc.Server()
  server.addService(descriptor.proompteng.runtime.v1.MicroVMControlPlane.service, {
    createAgent(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      receivedMetadata = call.metadata
      receivedRequest = call.request
      callback(null, {
        id: 'agent-test',
        displayName: String(call.request.displayName),
        phase: 'AGENT_PHASE_READY',
        architecture: 'ARCHITECTURE_ARM64',
        cpuMillis: 2_000,
        memoryMib: 4_096,
        workspaceGib: 16,
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
    readFile(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
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
      call.end()
    },
    resolveCodexApproval(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      receivedRequest = call.request
      callback(null, {})
    },
    resumeCodexThread(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      receivedRequest = call.request
      if (call.request.threadId === 'invalid-sequence') {
        callback(null, {
          id: String(call.request.threadId),
          rawJson: '{"thread":{"id":"invalid-sequence"}}',
          eventSequence: '-1',
        })
        return
      }
      callback(null, {
        id: String(call.request.threadId),
        rawJson: '{"thread":{"id":"thread-test"}}',
        eventSequence: '42',
      })
    },
  })
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, boundPort) => {
      if (error) reject(error)
      else resolve(boundPort)
    })
  })
  process.env.TENGRI_GRPC_ENDPOINT = `127.0.0.1:${port}`
  process.env.TENGRI_GRPC_TLS = 'false'
  process.env.TENGRI_INTERNAL_HMAC_SECRET = secret
  process.env.TENGRI_PROTO_PATH = protoPath
})

afterAll(async () => {
  const state = globalThis as typeof globalThis & { tengriGrpcClient?: grpc.Client; tengriGrpcService?: unknown }
  state.tengriGrpcClient?.close()
  delete state.tengriGrpcClient
  delete state.tengriGrpcService
  await new Promise<void>((resolve) => server.tryShutdown(() => resolve()))
})

describe('Tengri gRPC BFF transport', () => {
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

  test('rejects non-UTF-8 files instead of corrupting their bytes', async () => {
    const { readFile } = await import('./grpc')
    const error = await rejection(readFile('github:42', 'agent-test', '/workspace/binary'))

    expect(error).toMatchObject({
      message: 'This file is not valid UTF-8 text',
      status: 415,
    })
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
    const stream = watchFiles('github:42', 'agent-test', '/workspace')
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

    const resumed = watchFiles('github:42', 'agent-test', '/workspace', 0)
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
    const { resumeCodexThread } = await import('./grpc')

    const thread = await resumeCodexThread('github:42', 'agent-test', 'thread-test')
    expect(receivedRequest).toEqual({ agentId: 'agent-test', threadId: 'thread-test' })
    expect(thread).toEqual({
      id: 'thread-test',
      rawJson: '{"thread":{"id":"thread-test"}}',
      eventSequence: 42,
    })
  })

  test('rejects an invalid event cursor returned with a thread snapshot', async () => {
    const { resumeCodexThread } = await import('./grpc')

    expect(await rejection(resumeCodexThread('github:42', 'agent-test', 'invalid-sequence'))).toMatchObject({
      message: 'Tengri control plane returned an invalid Codex event cursor',
      status: 503,
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
